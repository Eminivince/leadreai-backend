import mongoose, { Schema } from 'mongoose';
import {
  INVOCATION_STATUSES,
  INVOCATION_TRIGGERS,
  COST_CATEGORIES,
  type InvocationStatus,
  type InvocationTrigger,
  type CostCategory,
} from '../../shared/index.js';

/**
 * One row per data source call. Powers:
 *  - the invocation log UI (admin / audit)
 *  - per-source reliability metrics
 *  - evidence-export join (Lead.sources[i].invocationId → this row)
 *  - debugging (input/output snapshot capped to fit Mongo's 16MB doc cap)
 *
 * Cost rolls up into CostEvent (Phase 13) — we keep `costUSD` + `costCategory`
 * here so the invocation detail doesn't need a second query.
 *
 * Retention: 180 days TTL, matching CostEvent. Aggregate rollups live
 * in WorkspaceUsageMonthly (future).
 */
export interface IDataSourceInvocationDoc extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  dataSourceId: string;
  credentialId?: mongoose.Types.ObjectId;
  triggeredBy: InvocationTrigger;
  parentJobId?: mongoose.Types.ObjectId;
  parentLeadId?: mongoose.Types.ObjectId;
  parentTableRowId?: mongoose.Types.ObjectId;
  parentColumnKey?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: InvocationStatus;
  errorMessage?: string;
  latencyMs?: number;
  costUSD?: number;
  costCategory?: CostCategory;
  occurredAt: Date;
}

const dataSourceInvocationSchema = new Schema<IDataSourceInvocationDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    dataSourceId: { type: String, required: true, maxlength: 100 },
    credentialId: { type: Schema.Types.ObjectId, ref: 'DataSourceCredential' },
    triggeredBy: { type: String, enum: INVOCATION_TRIGGERS, required: true },
    parentJobId: { type: Schema.Types.ObjectId, ref: 'ProspectingJob', index: true },
    parentLeadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    parentTableRowId: { type: Schema.Types.ObjectId },   // ref added in 15C
    parentColumnKey: { type: String, maxlength: 80 },
    input: { type: Schema.Types.Mixed, required: true },
    output: { type: Schema.Types.Mixed },
    status: { type: String, enum: INVOCATION_STATUSES, required: true },
    errorMessage: { type: String, maxlength: 1000 },
    latencyMs: { type: Number, min: 0 },
    costUSD: { type: Number, min: 0 },
    costCategory: { type: String, enum: COST_CATEGORIES },
    occurredAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

dataSourceInvocationSchema.index({ workspaceId: 1, occurredAt: -1 });
dataSourceInvocationSchema.index({ dataSourceId: 1, occurredAt: -1 });
dataSourceInvocationSchema.index({ occurredAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export default mongoose.model<IDataSourceInvocationDoc>('DataSourceInvocation', dataSourceInvocationSchema);
