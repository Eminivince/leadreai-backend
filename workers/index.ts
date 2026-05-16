import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import mongoose from 'mongoose';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { initSentry, captureException } from './lib/sentry.js';
import { createProspectingWorker } from './prospecting.worker.js';
import { createOutreachWorker } from './outreach.worker.js';
import { createContactWorker } from './contact.worker.js';
import { createHubspotWorker } from './hubspot.worker.js';
import { createSequenceWorker } from './sequence.worker.js';
import { createDocumentWorker } from './document.worker.js';
import { createSubagentProspectingWorker } from './subagentProspecting.worker.js';
import { startSequenceScheduler } from './sequenceScheduler.js';

/**
 * List of every BullMQ queue this repo declares. Must stay in sync with
 * worker + queue declarations across the codebase — if you add a new
 * queue, add its name here too, otherwise CLEAR_QUEUES_ON_BOOT will miss
 * it and jobs on that queue will survive reboot.
 */
const ALL_QUEUE_NAMES = [
  'prospecting',
  'prospecting-subagent',
  'outreach',
  'contact-enrichment',
  'hubspot-sync',
  'sequence-step',
  'document-process',
] as const;

const QUEUE_PREFIX = `{bull}:leadreai:${env.NODE_ENV}`;

/**
 * Dev helper. Empties every queue's active + waiting + delayed + failed
 * + completed sets, then calls `obliterate({force:true})` which wipes
 * all Redis state for the queue including orphaned locks from dead
 * workers. Runs *before* we attach any Worker so there's no window
 * where a fresh worker picks up a stalled job mid-clear.
 *
 * Guarded behind CLEAR_QUEUES_ON_BOOT AND NODE_ENV !== 'production' —
 * double protection because draining prod would be catastrophic.
 */
async function clearAllQueues(redisUrl: string): Promise<void> {
  if (env.NODE_ENV === 'production') {
    logger.warn('CLEAR_QUEUES_ON_BOOT ignored in production — refusing to drain live queues');
    return;
  }

  logger.warn('CLEAR_QUEUES_ON_BOOT=true — draining all queues before starting workers');

  // Each Queue needs its own connection because obliterate() terminates
  // it. Using one shared connection would leave the next Queue trying to
  // speak to a closed socket.
  for (const name of ALL_QUEUE_NAMES) {
    const conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    try {
      const queue = new Queue(name, { connection: conn, prefix: QUEUE_PREFIX });
      // `force: true` drops even `active` jobs (normally obliterate
      // refuses while any job is active — exactly the case we want to
      // rescue from).
      await queue.obliterate({ force: true });
      await queue.close();
      logger.info(`Queue cleared: ${name}`);
    } catch (err) {
      logger.error(`Failed to clear queue ${name}`, { err: (err as Error).message });
    } finally {
      await conn.quit().catch(() => { /* already closed */ });
    }
  }

  logger.info('All queues cleared');
}

/**
 * Flip any Mongo `ProspectingJob` left in a non-terminal state to
 * `cancelled`. Paired with `clearAllQueues` — obliterating Redis
 * alone would leave the UI showing "active" jobs that will never
 * complete. Uses a strict:false, late-bound connection because the
 * workers package doesn't import the backend's typed models.
 */
async function cancelOrphanedJobs(): Promise<void> {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
    }

    const jobSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ProspectingJob: mongoose.Model<any> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mongoose.models['ProspectingJob'] as mongoose.Model<any> | undefined) ??
      mongoose.model('ProspectingJob', jobSchema);

    const NON_TERMINAL = ['queued', 'parsing', 'collecting', 'enriching', 'deduplicating'];
    const result = await ProspectingJob.updateMany(
      { status: { $in: NON_TERMINAL } },
      {
        $set: {
          status: 'cancelled',
          completedAt: new Date(),
          'error.message': 'Cancelled by CLEAR_QUEUES_ON_BOOT — worker restarted',
          'error.stage': 'boot_cancel',
        },
      },
    );
    if (result.modifiedCount > 0) {
      logger.info(`Marked ${result.modifiedCount} orphaned job(s) as cancelled`);
    }
  } catch (err) {
    logger.error('cancelOrphanedJobs failed', { err: (err as Error).message });
  }
}
// Data source registry bootstrap — side-effect import populates the
// worker-side registry at process start. Downstream worker code that
// wants to call `runWorkerDataSource(...)` relies on this already having
// executed.
import './services/data-sources/sources/index.js';

// Process-level safety net for workers. Same rationale as backend: log,
// give logger 100ms to flush, then let the orchestrator restart. A wedged
// worker with an unhandled rejection silently failing jobs is worse than a
// loud restart.
process.on('uncaughtException', (err) => {
  logger.error('[workers] uncaughtException — exiting', {
    error: err.message,
    stack: err.stack,
  });
  captureException(err, { source: 'uncaughtException' });
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[workers] unhandledRejection — exiting', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  captureException(reason, { source: 'unhandledRejection' });
  setTimeout(() => process.exit(1), 100);
});

async function bootstrap() {
  initSentry();
  // Dev pain-reliever: purge any stalled jobs from a previous process
  // before we attach fresh workers. Does nothing unless the env flag is
  // set and we're outside production.
  if (env.CLEAR_QUEUES_ON_BOOT) {
    await clearAllQueues(env.REDIS_URL);
    await cancelOrphanedJobs();
  }

  // Each BullMQ Worker needs its own Redis connection — sharing one instance causes
  // shutdown ordering issues and violates BullMQ's ownership model.
  const prospectingConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  prospectingConn.on('error', (err) => logger.error('Prospecting Redis error', { err }));

  const outreachConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  outreachConn.on('error', (err) => logger.error('Outreach Redis error', { err }));

  const contactConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  contactConn.on('error', (err) => logger.error('Contact Redis error', { err }));

  const hubspotConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  hubspotConn.on('error', (err) => logger.error('HubSpot Redis error', { err }));

  const sequenceConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  sequenceConn.on('error', (err) => logger.error('Sequence Redis error', { err }));

  const documentConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  documentConn.on('error', (err) => logger.error('Document Redis error', { err }));

  const schedulerConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  schedulerConn.on('error', (err) => logger.error('Scheduler Redis error', { err }));

  const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  publisher.on('connect', () => logger.info('Workers Redis connected'));
  publisher.on('error', (err) => logger.error('Publisher Redis error', { err }));

  const prospectingWorker = await createProspectingWorker(prospectingConn, publisher);
  logger.info('Prospecting worker ready', { concurrency: env.WORKER_CONCURRENCY });

  const outreachWorker = await createOutreachWorker(outreachConn, publisher);
  logger.info('Outreach worker ready', { concurrency: env.WORKER_CONCURRENCY });

  const contactWorker = createContactWorker(contactConn);
  logger.info('Contact worker ready', { concurrency: env.CONTACT_ENRICHMENT_CONCURRENCY });

  const hubspotWorker = createHubspotWorker(hubspotConn);
  logger.info('HubSpot sync worker ready', { concurrency: env.WORKER_CONCURRENCY });

  const sequenceWorker = createSequenceWorker(sequenceConn, publisher);
  logger.info('Sequence worker ready', { concurrency: env.WORKER_CONCURRENCY });

  const documentWorker = createDocumentWorker(documentConn);
  logger.info('Document worker ready', { concurrency: 2 });

  const subagentConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  subagentConn.on('error', (err) => logger.error('Subagent Redis error', { err }));

  const subagentWorker = createSubagentProspectingWorker(subagentConn, publisher);
  logger.info('Subagent prospecting worker started', { concurrency: env.SUBAGENT_CONCURRENCY });

  const scheduler = startSequenceScheduler(schedulerConn);
  logger.info('Sequence scheduler started');

  let isShuttingDown = false;
  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down workers`);
    clearInterval(scheduler.timer);
    await scheduler.close();
    await Promise.all([prospectingWorker.close(), outreachWorker.close(), contactWorker.close(), hubspotWorker.close(), sequenceWorker.close(), documentWorker.close(), subagentWorker.close()]);
    await publisher.quit();
    await Promise.all([prospectingConn.quit(), outreachConn.quit(), contactConn.quit(), hubspotConn.quit(), sequenceConn.quit(), documentConn.quit(), schedulerConn.quit(), subagentConn.quit()]);
    logger.info('Worker shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}

bootstrap().catch((err) => {
  logger.error('Failed to start workers', { err });
  process.exit(1);
});
