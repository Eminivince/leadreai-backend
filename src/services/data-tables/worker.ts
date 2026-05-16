import { Worker, type Job } from 'bullmq';
import { getRedis } from '../../config/redis.js';
import { QUEUE_PREFIX } from '../queue/queues.js';
import { enrichOne } from './enrichment.js';
import { logger } from '../../utils/logger.js';

/**
 * Table enrichment worker — runs backend-side because the data source
 * handlers for Apollo/Hunter/ZeroBounce are registered on the backend
 * executor, and credential decryption lives there.
 *
 * One job per (table, column, row). Concurrency is shared across the
 * backend process and governed by the executor's own per-source rate
 * limits — the Redis rate-limit counters prevent a burst of parallel
 * workers from hammering any one provider.
 *
 * Started from backend/src/index.ts at server boot — lifecycle tied to
 * the Express process. Graceful shutdown on SIGTERM.
 */

interface EnrichmentJobData {
  workspaceId: string;
  tableId: string;
  columnKey: string;
  rowId: string;
  enrichmentRunId: string;
}

let _worker: Worker | null = null;

export function startTableEnrichmentWorker(): Worker {
  if (_worker) return _worker;

  _worker = new Worker<EnrichmentJobData>(
    'table-enrichment',
    async (job: Job<EnrichmentJobData>) => {
      const { workspaceId, tableId, columnKey, rowId, enrichmentRunId } = job.data;
      const tag = `[tableEnrichment:${enrichmentRunId}:${rowId}]`;

      try {
        const result = await enrichOne({ workspaceId, tableId, rowId, columnKey });
        logger.info(`${tag} ${result.status}`, {
          invocationId: result.invocationId,
          errorMessage: result.errorMessage,
        });
        return result;
      } catch (err) {
        // Fatal handler error (not a classified invocation failure — the
        // executor catches those). Re-throw so BullMQ marks the job failed
        // and retry logic kicks in.
        logger.error(`${tag} fatal`, {
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      concurrency: 4,
    },
  );

  _worker.on('error', (err) => {
    logger.error('[tableEnrichment] worker error', { err });
  });

  return _worker;
}

export async function stopTableEnrichmentWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
}
