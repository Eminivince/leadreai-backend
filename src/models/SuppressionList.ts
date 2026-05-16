import mongoose, { Schema } from 'mongoose';

export interface ISuppressionEntry extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  email?: string;
  domain?: string;
  reason: 'unsubscribe' | 'bounce' | 'manual' | 'competitor';
  addedAt: Date;
  addedBy?: mongoose.Types.ObjectId;
}

const suppressionSchema = new Schema<ISuppressionEntry>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    email: { type: String, lowercase: true, trim: true },
    domain: { type: String, lowercase: true, trim: true },
    reason: { type: String, enum: ['unsubscribe', 'bounce', 'manual', 'competitor'], required: true },
    addedAt: { type: Date, default: Date.now },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: false },
);

suppressionSchema.index({ workspaceId: 1, email: 1 }, { unique: true, sparse: true });
suppressionSchema.index({ workspaceId: 1, domain: 1 }, { unique: true, sparse: true });

export const SuppressionEntry = mongoose.model<ISuppressionEntry>('SuppressionEntry', suppressionSchema);
