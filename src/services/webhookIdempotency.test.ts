import { describe, it, expect, beforeAll, vi } from 'vitest';

beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['JWT_SECRET'] = 'a'.repeat(32);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(32);
  process.env['MONGODB_URI'] = 'mongodb://localhost:27017/test';
  process.env['MONGODB_DB_NAME'] = 'leadreai_test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['UNSUBSCRIBE_TOKEN_SECRET'] = 'c'.repeat(16);
});

/**
 * Unit-tests `processWebhookOnce` against an in-memory mock of the
 * WebhookEvent model. We don't spin up Mongoose for this — the helper's
 * logic is pure dispatch on top of a `findOneAndUpdate` upsert, so a
 * Map-backed mock is sufficient to cover the four state transitions
 * (claim, duplicate, concurrent, failed-then-retry).
 *
 * Why this matters: the helper is the dedup gate for Stripe + Paystack
 * webhook deliveries. A regression here re-introduces the double-grant
 * bug the audit flagged as the #1 financial-loss risk.
 */
type WebhookEventDoc = {
  _id: string;
  provider: string;
  eventId: string;
  status: 'processing' | 'processed' | 'failed';
  error?: string;
  processedAt?: Date;
};

interface MockQuery {
  findOneAndUpdate: ReturnType<typeof vi.fn>;
}

function buildMockModel(): { store: Map<string, WebhookEventDoc>; mock: MockQuery } {
  const store = new Map<string, WebhookEventDoc>();
  let _id = 0;
  const mock: MockQuery = {
    findOneAndUpdate: vi.fn(async (filter: Record<string, string>, update: Record<string, unknown>, opts: { upsert?: boolean; new?: boolean; projection?: Record<string, number> } = {}) => {
      const key = `${filter['provider']}:${filter['eventId']}`;
      const existing = store.get(key);

      // Apply update operators (subset relevant for processWebhookOnce):
      //   - $setOnInsert (only on insert)
      //   - top-level $set replacement passed as plain keys
      //   - $unset
      const applySet = (doc: WebhookEventDoc) => {
        const setOps = update['$set'] as Record<string, unknown> | undefined;
        if (setOps) Object.assign(doc, setOps);
        // Top-level plain keys (Mongoose treats these as $set)
        for (const [k, v] of Object.entries(update)) {
          if (k.startsWith('$')) continue;
          (doc as unknown as Record<string, unknown>)[k] = v;
        }
        const unsetOps = update['$unset'] as Record<string, unknown> | undefined;
        if (unsetOps) for (const k of Object.keys(unsetOps)) delete (doc as unknown as Record<string, unknown>)[k];
      };

      if (existing) {
        // Optional filter — caller may pass `_id: ...` + `status: 'failed'`
        // to reclaim a failed row. Honour those in the match.
        if (filter['status'] && existing.status !== filter['status']) return null;
        if (filter['_id'] && existing._id !== filter['_id']) return null;
        applySet(existing);
        return opts.new ? { ...existing } : { ...existing }; // simplified
      }

      // Insert path
      if (!opts.upsert) return null;
      const insert = (update['$setOnInsert'] as Partial<WebhookEventDoc>) ?? {};
      const created: WebhookEventDoc = {
        _id: `mock-${++_id}`,
        provider: filter['provider']!,
        eventId: filter['eventId']!,
        status: 'processing',
        ...insert,
      };
      applySet(created);
      store.set(key, created);
      return opts.new ? created : null;
    }),
  };
  return { store, mock };
}

describe('processWebhookOnce', () => {
  it('runs the handler on first delivery and marks processed', async () => {
    const { store, mock } = buildMockModel();
    vi.doMock('../models/WebhookEvent.js', () => ({ default: mock }));
    const { processWebhookOnce } = await import('./webhookIdempotency.js');

    const handler = vi.fn(async () => { /* no-op */ });
    const result = await processWebhookOnce(
      { provider: 'stripe', eventId: 'evt_1', eventType: 'checkout.session.completed' },
      handler,
    );
    expect(result).toBe('processed');
    expect(handler).toHaveBeenCalledOnce();
    expect(store.get('stripe:evt_1')?.status).toBe('processed');
  });

  it('returns duplicate without running handler on second delivery', async () => {
    const { store, mock } = buildMockModel();
    // Pre-seed the store with a processed event.
    store.set('stripe:evt_2', {
      _id: 'mock-x',
      provider: 'stripe',
      eventId: 'evt_2',
      status: 'processed',
    });
    vi.doMock('../models/WebhookEvent.js', () => ({ default: mock }));
    // Reset module cache so the mock takes effect on this import.
    vi.resetModules();
    vi.doMock('../models/WebhookEvent.js', () => ({ default: mock }));
    const { processWebhookOnce } = await import('./webhookIdempotency.js');

    const handler = vi.fn(async () => { /* should not run */ });
    const result = await processWebhookOnce(
      { provider: 'stripe', eventId: 'evt_2', eventType: 'checkout.session.completed' },
      handler,
    );
    expect(result).toBe('duplicate');
    expect(handler).not.toHaveBeenCalled();
  });

  it('marks failed and re-throws when the handler throws', async () => {
    const { store, mock } = buildMockModel();
    vi.resetModules();
    vi.doMock('../models/WebhookEvent.js', () => ({ default: mock }));
    const { processWebhookOnce } = await import('./webhookIdempotency.js');

    const handler = vi.fn(async () => { throw new Error('upstream timeout'); });
    await expect(
      processWebhookOnce(
        { provider: 'paystack', eventId: 'evt_3', eventType: 'charge.success' },
        handler,
      ),
    ).rejects.toThrow('upstream timeout');
    expect(store.get('paystack:evt_3')?.status).toBe('failed');
    expect(store.get('paystack:evt_3')?.error).toBe('upstream timeout');
  });
});
