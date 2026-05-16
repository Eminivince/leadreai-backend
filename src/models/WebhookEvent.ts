import mongoose, { Schema } from 'mongoose';

/**
 * Webhook idempotency store.
 *
 * Every payment provider (Stripe, Paystack) emits a unique event ID per
 * delivery. Providers WILL retry deliveries on transient receiver errors,
 * which means an "at-most-once" handler is mandatory for any flow that
 * grants credits or mutates user state. Without this table, a retry after
 * a partial-success response double-grants credits.
 *
 * Invariant: `(provider, eventId)` is unique. The compound unique index
 * makes the dedup check + insert race-safe — concurrent webhook deliveries
 * for the same eventId collapse to one inserted row + N duplicate-key
 * errors. The handler swallows the dup-key as "already processed".
 */
export interface IWebhookEvent extends mongoose.Document {
  provider: 'stripe' | 'paystack';
  eventId: string;
  eventType: string;
  status: 'processing' | 'processed' | 'failed';
  processedAt?: Date;
  error?: string;
  // Trimmed metadata for forensics (NOT the full raw body — we don't want
  // PCI-relevant payment details in our DB beyond what the providers expose).
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    provider: { type: String, enum: ['stripe', 'paystack'], required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true, index: true },
    status: { type: String, enum: ['processing', 'processed', 'failed'], required: true, default: 'processing' },
    processedAt: { type: Date },
    error: { type: String, maxlength: 1000 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Idempotency anchor. A duplicate insert MUST throw E11000 so the handler
// can detect "already seen this event" without a separate read-then-write
// race window.
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

// TTL on old events — keep 90 days for dispute investigation, then expire.
// Failed events stay longer for triage but we cap with the same TTL since
// the credit ledger preserves the financial trail independently.
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 });

export default mongoose.model<IWebhookEvent>('WebhookEvent', webhookEventSchema);
