import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { fireWebhook } from './services/webhook.js';
import { runIntentParser, jobActivity } from './pipeline/intentParser.js';
import { emitNotification } from './services/notificationEmitter.js';
import { runWithCostContext } from './services/costTracker.js';

async function connectDB(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  logger.info('Worker MongoDB connected');
}

export async function createProspectingWorker(connection: Redis, publisher: Redis): Promise<Worker> {
  await connectDB();

  const prefix = `{bull}:leadreai:${env.NODE_ENV}`;

  const worker = new Worker(
    'prospecting',
    async (job: Job) => {
      const { jobId, workspaceId } = job.data as { jobId: string; workspaceId: string };
      logger.info('Prospecting job received', { jobId, workspaceId });

      try {
        // Establish the cost scope for this job. Every LLM / SERP / file /
        // scrape / transcription / embedding call made downstream will be
        // attributed to this workspace + job via AsyncLocalStorage.
        await runWithCostContext({ workspaceId, jobId }, () =>
          runIntentParser(jobId, workspaceId, publisher),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Pipeline failed', { jobId, err });

        // Mark job as failed in DB + publish error event
        const ProspectingJob = mongoose.models['ProspectingJob'] as
          | mongoose.Model<mongoose.Document>
          | undefined;

        if (ProspectingJob) {
          await ProspectingJob.findByIdAndUpdate(jobId, {
            status: 'failed',
            'error.message': message,
            'error.stage': 'pipeline',
          });
        }

        await jobActivity(jobId, publisher, 'error', `Pipeline failed: ${message}`, {
          stage: 'pipeline',
          stackPreview: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
        }).catch(() => {});

        await publisher.publish(
          `job:progress:${jobId}`,
          JSON.stringify({ type: 'error', message })
        );

        // Fire webhook to workspace
        const ws = await mongoose.model('Workspace').findById(workspaceId, { 'settings.webhookUrl': 1 }).lean() as { settings?: { webhookUrl?: string } } | null;
        if (ws?.settings?.webhookUrl) {
          fireWebhook(ws.settings.webhookUrl, { event: 'job:failed', jobId, workspaceId, status: 'failed', error: message }, env.WEBHOOK_TIMEOUT_MS);
        }

        // Push an in-app notification so the user learns the run broke
        await emitNotification({
          workspaceId,
          type: 'job.failed',
          title: 'Dispatch failed.',
          message: message.length > 200 ? `${message.slice(0, 197)}…` : message,
          href: `/dashboard/leads?jobId=${jobId}`,
          metadata: { jobId, stage: 'pipeline' },
        });

        throw err; // re-throw so BullMQ marks job as failed and retries
      }
    },
    {
      connection,
      prefix,
      concurrency: env.WORKER_CONCURRENCY,
    }
  );

  worker.on('completed', (job) => {
    logger.info('Job completed', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('Job failed', { jobId: job?.id, err });
  });

  worker.on('error', (err) => {
    logger.error('Worker error', { err });
  });

  return worker;
}
