import mongoose, { Schema } from 'mongoose';
import { CREDIT_TXN_REASONS, type CreditTransactionReason, type CreditBucket } from '../../shared/index.js';

export { CREDIT_TXN_REASONS };
export type { CreditTransactionReason };

const CREDIT_BUCKETS: readonly CreditBucket[] = ['monthly', 'topup'] as const;

export interface ICreditTransaction extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  workspaceId?: mongoose.Types.ObjectId;
  kind: 'debit' | 'credit';
  reason: CreditTransactionReason;
  // Which wallet this row moved.
  bucket: CreditBucket;
  // Signed delta in credits — positive for credit, negative for debit.
  delta: number;
  // Snapshot of that bucket's balance after this row (not the user's
  // combined balance).
  balanceAfter: number;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const creditTransactionSchema = new Schema<ICreditTransaction>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace' },
    kind: { type: String, enum: ['debit', 'credit'], required: true },
    reason: { type: String, enum: CREDIT_TXN_REASONS, required: true },
    bucket: { type: String, enum: CREDIT_BUCKETS, required: true },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    description: { type: String, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

creditTransactionSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model<ICreditTransaction>(
  'CreditTransaction',
  creditTransactionSchema,
);
