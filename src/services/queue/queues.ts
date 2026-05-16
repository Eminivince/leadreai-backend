import { Queue } from 'bullmq';
import { getRedis } from '../../config/redis.js';
import { env } from '../../config/env.js';

export const QUEUE_PREFIX = `{bull}:leadreai:${env.NODE_ENV}`;

const defaultJobOptions = {
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

let _prospectingQueue: Queue | null = null;
let _enrichmentQueue: Queue | null = null;
let _outreachQueue: Queue | null = null;
let _exportQueue: Queue | null = null;
let _contactEnrichmentQueue: Queue | null = null;
let _hubspotSyncQueue: Queue | null = null;
let _sequenceStepQueue: Queue | null = null;
let _documentQueue: Queue | null = null;
let _tableEnrichmentQueue: Queue | null = null;
let _subagentProspectingQueue: Queue | null = null;

export function getProspectingQueue(): Queue {
  if (!_prospectingQueue) {
    _prospectingQueue = new Queue('prospecting', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions,
    });
  }
  return _prospectingQueue;
}

export function getEnrichmentQueue(): Queue {
  if (!_enrichmentQueue) {
    _enrichmentQueue = new Queue('enrichment', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions,
    });
  }
  return _enrichmentQueue;
}

export function getOutreachQueue(): Queue {
  if (!_outreachQueue) {
    _outreachQueue = new Queue('outreach', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions,
    });
  }
  return _outreachQueue;
}

export function getExportQueue(): Queue {
  if (!_exportQueue) {
    _exportQueue = new Queue('export', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions,
    });
  }
  return _exportQueue;
}

export function getContactEnrichmentQueue(): Queue {
  if (!_contactEnrichmentQueue) {
    _contactEnrichmentQueue = new Queue('contact-enrichment', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions,
    });
  }
  return _contactEnrichmentQueue;
}

export function getHubspotSyncQueue(): Queue {
  if (!_hubspotSyncQueue) {
    _hubspotSyncQueue = new Queue('hubspot-sync', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions,
    });
  }
  return _hubspotSyncQueue;
}

export function getDocumentQueue(): Queue {
  if (!_documentQueue) {
    _documentQueue = new Queue('document-process', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
      },
    });
  }
  return _documentQueue;
}

export function getSequenceStepQueue(): Queue {
  if (!_sequenceStepQueue) {
    _sequenceStepQueue = new Queue('sequence-step', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 2000 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
      },
    });
  }
  return _sequenceStepQueue;
}

export function getTableEnrichmentQueue(): Queue {
  if (!_tableEnrichmentQueue) {
    _tableEnrichmentQueue = new Queue('table-enrichment', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      // Phase 15D — one job per (table, column, row). Failures retry
      // twice with exponential backoff; provider rate-limits are already
      // classified as 'rate_limited' by the executor and re-run will
      // happen when user retriggers rather than auto-retrying rapidly.
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
      },
    });
  }
  return _tableEnrichmentQueue;
}

export function getSubagentProspectingQueue(): Queue {
  if (!_subagentProspectingQueue) {
    _subagentProspectingQueue = new Queue('prospecting-subagent', {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 50 } },
    });
  }
  return _subagentProspectingQueue;
}
