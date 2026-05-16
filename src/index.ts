import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { getRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { initSentry, captureException } from './lib/sentry.js';
// Data source registry bootstrap — side-effect import. Each per-source
// module calls registerDataSource() at top level, so importing the barrel
// once at server start populates the registry before any request handler
// queries it.
import './services/data-sources/sources/index.js';
import { startTableEnrichmentWorker, stopTableEnrichmentWorker } from './services/data-tables/worker.js';
import { startSequenceWorker, stopSequenceWorker } from './services/sequenceWorker.js';
import { startGmailInboundPoller, stopGmailInboundPoller } from './services/gmailInboundPoller.js';
import { startBudgetChecker, stopBudgetChecker } from './services/budgetChecker.js';

// Process-level safety net. An uncaught exception in an async handler that
// escapes Express, or a Promise rejection nobody attached `.catch` to, will
// crash the process. We let it crash (Node's default is correct here — the
// state is potentially corrupt) but log structured context first so the
// post-mortem isn't blind. The orchestrator will restart the pod.
process.on('uncaughtException', (err) => {
  logger.error('[backend] uncaughtException — exiting', {
    error: err.message,
    stack: err.stack,
  });
  captureException(err, { service: 'backend', source: 'uncaughtException' });
  // Give the logger + Sentry transport a tick to flush, then bail.
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[backend] unhandledRejection — exiting', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  captureException(reason, { service: 'backend', source: 'unhandledRejection' });
  setTimeout(() => process.exit(1), 100);
});

/**
 * Verify at least one LLM provider is configured before we accept traffic.
 *
 * The product cannot complete the goal.md core loop without an LLM. The
 * symptom of "started fine but jobs silently fail" is one of the worst
 * production failure modes — better to refuse to boot than to look healthy
 * while every dispatched job lands in `status: 'failed'` with no UI signal.
 */
function assertLlmConfigured(): void {
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
  const hasGoogle = Boolean(env.GOOGLE_API_KEY);
  const hasOpenRouter = Boolean(env.OPENROUTER_API_KEY);
  const hasLocal = Boolean(env.USE_LOCAL_LLM);
  if (!hasAnthropic && !hasGoogle && !hasOpenRouter && !hasLocal) {
    logger.error(
      '[backend] no LLM provider configured — set ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, or USE_LOCAL_LLM=true. Refusing to start.',
    );
    process.exit(1);
  }
  logger.info('[backend] LLM provider ready', {
    anthropic: hasAnthropic,
    google: hasGoogle,
    openrouter: hasOpenRouter,
    local: hasLocal,
  });
}

async function bootstrap() {
  // Sentry first — we want crash reporting active for the LLM check and
  // DB connect, not just for runtime handlers.
  initSentry('backend');
  assertLlmConfigured();
  await connectDatabase();
  getRedis(); // initialize connection
  const app = createApp();

  // Phase 15D — column-referenced enrichment worker. Runs inside the
  // Express process because handlers reach the backend data-source
  // executor + credential decryption path.
  startTableEnrichmentWorker();
  logger.info('Table enrichment worker started');

  startSequenceWorker();
  logger.info('Sequence worker started');

  // Gmail inbound poller (Task #13). Picks up replies for workspaces
  // that use Gmail OAuth as sender — they don't get a webhook surface
  // like Resend / SendGrid do.
  startGmailInboundPoller();
  logger.info('Gmail inbound poller started');

  // Cost budget alerts (Task #15). Hourly checker emits a notification
  // when month-to-date spend crosses the workspace threshold.
  startBudgetChecker();
  logger.info('Budget checker started');

  const server = app.listen(env.PORT, () => {
    logger.info(`Backend listening on port ${env.PORT}`);
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down`);
    server.close(async () => {
      stopSequenceWorker();
      stopGmailInboundPoller();
      stopBudgetChecker();
      await stopTableEnrichmentWorker();
      await mongoose.connection.close();
      await getRedis().quit();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}

bootstrap().catch((err) => {
  logger.error('Failed to start server', { err });
  process.exit(1);
});
