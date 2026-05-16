import { describe, it, expect } from 'vitest';
import {
  computeLlmCost,
  computeSerpCost,
  computeEmailSendCost,
  computeEmbeddingCost,
} from './pricing.js';

/**
 * Pricing-table sanity tests. These guard against a future regression
 * where someone edits a unit price and accidentally introduces an
 * off-by-1000 error — exactly the kind of bug that produces a $30,000
 * cost line for a $30 month.
 */
describe('pricing.computeLlmCost', () => {
  it('prices a known Claude Sonnet model from the pricing table', () => {
    const { totalUSD, priceSnapshot } = computeLlmCost(
      'openrouter/anthropic/claude-sonnet-4-6',
      { input: 1_000_000, output: 1_000_000 },
    );
    // input $3/M + output $15/M for sonnet-4-6 in the LLM_PRICING table.
    expect(totalUSD).toBeCloseTo(3 + 15);
    expect(priceSnapshot.inputPer1M).toBe(3);
    expect(priceSnapshot.outputPer1M).toBe(15);
  });

  it('falls back to UNKNOWN_LLM_PRICING for an unrecognised slug', () => {
    const { totalUSD } = computeLlmCost('vendor/unicorn-7b', { input: 1_000_000, output: 0 });
    // UNKNOWN_LLM_PRICING.inputPer1M = $5
    expect(totalUSD).toBeCloseTo(5);
  });

  it('returns 0 for empty token counts', () => {
    const { totalUSD } = computeLlmCost('openrouter/anthropic/claude-sonnet-4-6', {});
    expect(totalUSD).toBe(0);
  });
});

describe('pricing.computeSerpCost', () => {
  it('uses the per-provider perCall rate', () => {
    const { totalUSD } = computeSerpCost('serpapi');
    expect(totalUSD).toBe(0.015);
  });

  it('falls back to a sane unknown-provider price', () => {
    const { totalUSD } = computeSerpCost('mystery');
    expect(totalUSD).toBeGreaterThan(0);
    expect(totalUSD).toBeLessThan(0.01);
  });
});

describe('pricing.computeEmailSendCost (Sprint 4.4)', () => {
  it('charges Resend at its per-send rate', () => {
    const { totalUSD } = computeEmailSendCost('resend');
    expect(totalUSD).toBe(0.0004);
  });

  it('charges SendGrid at its per-send rate', () => {
    const { totalUSD } = computeEmailSendCost('sendgrid');
    expect(totalUSD).toBe(0.0008);
  });

  it('zero-cost Gmail and SMTP since those bill outside our infra', () => {
    expect(computeEmailSendCost('gmail').totalUSD).toBe(0);
    expect(computeEmailSendCost('smtp').totalUSD).toBe(0);
  });

  it('falls back to UNKNOWN_EMAIL_PRICING for new providers', () => {
    const { totalUSD } = computeEmailSendCost('mailgun');
    expect(totalUSD).toBe(0.001);
  });
});

describe('pricing.computeEmbeddingCost', () => {
  it('prices 1M tokens at the configured per-1M rate', () => {
    const { totalUSD } = computeEmbeddingCost(1_000_000);
    expect(totalUSD).toBe(0.02);
  });

  it('scales linearly under 1M', () => {
    const { totalUSD } = computeEmbeddingCost(500_000);
    expect(totalUSD).toBeCloseTo(0.01);
  });
});
