import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { enrichContacts, type ContactEnrichmentPayload } from './pipeline/contactEnricher.js';

export function createContactWorker(connection: Redis): Worker {
  // Connect to Mongo if not already connected
  if (mongoose.connection.readyState === 0) {
    mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME }).catch(err =>
      logger.error('Contact worker Mongo connect error', { err })
    );
  }

  const worker = new Worker<ContactEnrichmentPayload>(
    'contact-enrichment',
    async (job: Job<ContactEnrichmentPayload>) => {
      logger.info('contact.worker: processing job', { jobId: job.id, leadId: job.data.leadId });
      await enrichContacts(job);
    },
    {
      connection,
      concurrency: env.CONTACT_ENRICHMENT_CONCURRENCY,
      prefix: `{bull}:leadreai:${env.NODE_ENV}`,
    }
  );

  worker.on('completed', job => logger.info('contact.worker: job completed', { jobId: job.id }));
  worker.on('failed', (job, err) => logger.error('contact.worker: job failed', { jobId: job?.id, err }));

  return worker;
}
