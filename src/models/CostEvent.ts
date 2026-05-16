import mongoose, { Schema } from 'mongoose';
import { COST_CATEGORIES, type CostCategory } from '../../shared/index.js';

export interface ICostEventDoc extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  jobId?: mongoose.Types.ObjectId;
  campaignId?: mongoose.Types.ObjectId;
  category: CostCategory;
  provider: string;
  modelSlug?: string;
  units: {
    input?: number;
    output?: number;
    cached?: number;
    count?: number;
    bytes?: number;
    seconds?: number;
  };
  unitPriceUSD?: Record<string, number>;
  totalCostUSD: number;
  occurredAt: Date;
  meta?: Record<string, unknown>;
}

const costEventSchema = new Schema<ICostEventDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'ProspectingJob', index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    category: { type: String, enum: COST_CATEGORIES, required: true },
    provider: { type: String, required: true, maxlength: 80 },
    modelSlug: { type: String, maxlength: 200 },
    units: {
      input: { type: Number, min: 0 },
      output: { type: Number, min: 0 },
      cached: { type: Number, min: 0 },
      count: { type: Number, min: 0 },
      bytes: { type: Number, min: 0 },
      seconds: { type: Number, min: 0 },
    },
    unitPriceUSD: { type: Schema.Types.Mixed },
    totalCostUSD: { type: Number, required: true, min: 0 },
    occurredAt: { type: Date, required: true, default: Date.now },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: false },
);

// Hot-path indexes for aggregation.
costEventSchema.index({ workspaceId: 1, occurredAt: -1 });
costEventSchema.index({ jobId: 1 });
costEventSchema.index({ campaignId: 1 });
costEventSchema.index({ workspaceId: 1, category: 1, occurredAt: -1 });

// Retention: 180 days. Billable rollups live in a separate collection
// (Workspace.usageMonthly) for long-term audit.
costEventSchema.index(
  { occurredAt: 1 },
  { expireAfterSeconds: 180 * 24 * 3600 },
);

export default mongoose.model<ICostEventDoc>('CostEvent', costEventSchema);
