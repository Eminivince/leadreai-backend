export const CREDIT_TXN_REASONS = [
  'dispatch',
  'dispatch.refund',
  'topup.test',
  'topup.stripe',
  'topup.paystack',
  'subscription.renewal',
  'subscription.change',
  'subscription.paystack',
  'adjustment',
  'signup',
  // Reversals — fired when a Stripe charge is refunded or a chargeback /
  // dispute is opened by the bank. Negative-delta debit on `topup` so the
  // ledger preserves the original grant alongside its reversal.
  'dispute.reversal',
  'refund.reversal',
] as const;

export type CreditTransactionReason = (typeof CREDIT_TXN_REASONS)[number];

/**
 * Which wallet a ledger entry moved.
 * - `monthly` — plan-granted credits; resets on subscription renewal.
 * - `topup`   — one-off purchases; rolls over forever.
 */
export type CreditBucket = 'monthly' | 'topup';

export interface CreditTransaction {
  _id: string;
  userId: string;
  workspaceId?: string;
  kind: 'debit' | 'credit';
  reason: CreditTransactionReason;
  bucket: CreditBucket;
  delta: number;
  // Snapshot of the bucket's balance after this row.
  balanceAfter: number;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Preset top-up packages. Prices are USD for display only — the test
 * endpoint ignores them and just grants the credit count. When Stripe
 * lands, the server will fetch its own package config from Stripe or
 * env, these are just the UI catalogue.
 */
export interface CreditPackage {
  id: string;
  credits: number;
  priceUsd: number;
  label: string;
  tagline?: string;
}

export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: 'trial',   credits: 20,   priceUsd: 19,   label: '20 dispatches',   tagline: 'A week of prospecting.' },
  { id: 'desk',    credits: 50,   priceUsd: 45,   label: '50 dispatches',   tagline: 'The working month.' },
  { id: 'bureau',  credits: 200,  priceUsd: 165,  label: '200 dispatches',  tagline: 'For the whole quarter.' },
  { id: 'annual',  credits: 1000, priceUsd: 750,  label: '1,000 dispatches', tagline: 'Wholesale. Year-round.' },
];
