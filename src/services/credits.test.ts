import { describe, it, expect } from 'vitest';
import { CREDIT_TXN_REASONS } from '../../shared/index.js';

/**
 * Unit tests for credit-system invariants.
 *
 * The full credits.ts module talks to Mongoose; testing the actual
 * grant/charge with a live DB belongs in an integration suite. The
 * critical invariants we can exercise without a live DB:
 *   - Reason-code enum stays in sync (a typo'd reason in a webhook
 *     handler throws at the schema layer, not at runtime).
 *   - Dispute / refund reversal reasons exist (added in Sprint 1).
 *
 * The integration suite (credits.integration.test.ts) is where we'll
 * test transaction rollback + concurrent spend + dedup webhook behaviour.
 */
describe('credits — reason-code surface', () => {
  it('exposes the canonical refund-reversal reason added in Sprint 1', () => {
    expect(CREDIT_TXN_REASONS).toContain('refund.reversal');
  });

  it('exposes the canonical dispute-reversal reason added in Sprint 1', () => {
    expect(CREDIT_TXN_REASONS).toContain('dispute.reversal');
  });

  it('exposes legacy reasons that pre-date the reversal work', () => {
    // Smoke-check the reason codes that existed before Sprint 1. A future
    // refactor that re-orders or removes these would silently break the
    // webhook handlers — this test fails loud first.
    expect(CREDIT_TXN_REASONS).toContain('dispatch');
    expect(CREDIT_TXN_REASONS).toContain('topup.stripe');
    expect(CREDIT_TXN_REASONS).toContain('topup.paystack');
    expect(CREDIT_TXN_REASONS).toContain('subscription.renewal');
    expect(CREDIT_TXN_REASONS).toContain('subscription.change');
  });

  it('has no duplicate reason codes', () => {
    const set = new Set<string>(CREDIT_TXN_REASONS);
    expect(set.size).toBe(CREDIT_TXN_REASONS.length);
  });
});
