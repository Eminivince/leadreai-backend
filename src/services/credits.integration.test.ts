/**
 * Integration tests for `services/credits.ts`.
 *
 * These run against a real Mongo replica set (transactions require one)
 * and are excluded from the default `pnpm test` run — they need infra.
 * To run locally:
 *
 *   docker run -p 27017:27017 mongo:7 --replSet rs0
 *   docker exec <id> mongosh --eval 'rs.initiate()'
 *   MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0 \
 *     pnpm vitest run --include "**\/*.integration.test.ts"
 *
 * In CI, wire a `mongodb` service container into the test job and set
 * `MONGODB_URI` from `secrets`. The suite is gated on
 * `RUN_INTEGRATION_TESTS=true` so a misconfigured developer machine
 * can't trip it open.
 *
 * Coverage targets (next session — these are scaffolded as
 * `.skip` so the harness exists and the contracts are documented):
 *   - chargeCredits — concurrent dispatch can't double-spend
 *   - chargeCredits — partial-bucket failure rolls back atomically
 *   - grantCredits — ledger write failure rolls back balance change
 *   - subscribeToPlan — renewal idempotent across N concurrent webhooks
 *   - processWebhookOnce — duplicate Stripe eventId returns 'duplicate'
 */
import { describe, it } from 'vitest';

const ENABLED = process.env['RUN_INTEGRATION_TESTS'] === 'true';

describe.skipIf(!ENABLED)('credits integration', () => {
  it.skip('chargeCredits is atomic across concurrent dispatch', async () => {
    // 1. Seed user with creditsBalance: 1
    // 2. Fire 10 chargeCredits(1) calls in parallel via Promise.all
    // 3. Assert: exactly one succeeds; nine throw ApiError 'Insufficient credits'
    // 4. Assert: User.creditsBalance === 0; exactly one CreditTransaction row
  });

  it.skip('chargeCredits rolls back ledger on partial-bucket failure', async () => {
    // Hard one — needs to simulate the rare race where topup shrinks
    // between read and write. The session.withTransaction() wrap should
    // roll the monthly portion back automatically.
  });

  it.skip('grantCredits rolls back balance change on ledger write failure', async () => {
    // Inject a mongoose.connection.db middleware that fails the
    // CreditTransaction.create inside the transaction; assert the
    // User.creditsBalance stays unchanged.
  });

  it.skip('subscribeToPlan is idempotent across concurrent webhooks', async () => {
    // Fire Promise.all([processWebhookOnce(...), processWebhookOnce(...)])
    // with the same (provider, eventId) and assert one runs, one returns
    // 'concurrent' or 'duplicate', and User.monthlyCreditsBalance ends
    // at exactly the plan's allowance (not 2x).
  });
});
