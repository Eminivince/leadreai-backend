import WebhookEvent from '../models/WebhookEvent.js';
import { logger } from '../utils/logger.js';

type Provider = 'stripe' | 'paystack';
type ProcessResult = 'processed' | 'duplicate' | 'concurrent';

interface ProcessWebhookOpts {
  provider: Provider;
  eventId: string;
  eventType: string;
  metadata?: Record<string, unknown>;
}

/**
 * Run `handler` at-most-once per `(provider, eventId)` pair.
 *
 * Returns:
 *   - 'processed'  : we claimed the event and the handler ran successfully.
 *   - 'duplicate'  : the event was already processed in a prior delivery.
 *   - 'concurrent' : another worker is processing the same event right now.
 *
 * Failure modes:
 *   - Handler throws → the WebhookEvent row is marked `status: 'failed'`
 *     with the error message. The error is re-raised so the route returns
 *     5xx and the provider retries delivery later. On retry, the failed
 *     row is reset to `processing` and the handler runs again.
 *
 * Race safety:
 *   - The unique compound index on `(provider, eventId)` collapses
 *     concurrent deliveries to a single insert; the loser sees
 *     `status: 'processing'` and returns 'concurrent' rather than running
 *     the handler in parallel. This prevents the double-grant bug that
 *     Stripe + Paystack docs explicitly warn about.
 */
export async function processWebhookOnce(
  opts: ProcessWebhookOpts,
  handler: () => Promise<void>,
): Promise<ProcessResult> {
  const { provider, eventId, eventType, metadata } = opts;

  // Atomic claim: try to insert a new row; if one exists, get the existing.
  // `new: false` returns the prior doc (or null on insert).
  const existing = await WebhookEvent.findOneAndUpdate(
    { provider, eventId },
    {
      $setOnInsert: {
        provider,
        eventId,
        eventType,
        status: 'processing',
        metadata,
      },
    },
    { upsert: true, new: false, projection: { status: 1 } },
  );

  if (existing) {
    if (existing.status === 'processed') {
      logger.info('[webhook] duplicate delivery — skipping', { provider, eventId, eventType });
      return 'duplicate';
    }
    if (existing.status === 'processing') {
      logger.warn('[webhook] concurrent delivery — another worker holds the lock', {
        provider, eventId, eventType,
      });
      return 'concurrent';
    }
    // status === 'failed' — prior attempt errored; reset and try again.
    const reclaimed = await WebhookEvent.findOneAndUpdate(
      { _id: existing._id, status: 'failed' },
      { status: 'processing', $unset: { error: 1 } },
      { new: true },
    );
    if (!reclaimed) {
      // Someone else reclaimed it between our check and update.
      logger.info('[webhook] failed event already reclaimed elsewhere', { provider, eventId });
      return 'concurrent';
    }
  }

  try {
    await handler();
    await WebhookEvent.findOneAndUpdate(
      { provider, eventId },
      { status: 'processed', processedAt: new Date() },
    );
    logger.info('[webhook] event processed', { provider, eventId, eventType });
    return 'processed';
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await WebhookEvent.findOneAndUpdate(
      { provider, eventId },
      { status: 'failed', error: errMsg },
    ).catch(() => { /* logging best-effort; preserve original error */ });
    logger.error('[webhook] handler failed', { provider, eventId, eventType, error: errMsg });
    throw err;
  }
}
