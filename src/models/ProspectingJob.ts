import mongoose, { Schema } from 'mongoose';
import { JOB_STATUSES } from '../../shared/index.js';
import type { ParsedIntent, ClarificationAnswer, JobCostSummary } from '../../shared/index.js';

export interface IProspectingJob extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  rawQuery: string;
  clarifications?: ClarificationAnswer[];
  parsedIntent?: ParsedIntent;
  status: (typeof JOB_STATUSES)[number];
  progress: {
    percentage: number;
    currentStage: string;
    stagesComplete: string[];
    leadsFoundSoFar: number;
  };
  result?: {
    totalLeadsFound: number;
    totalAfterDedup: number;
    dorkQueriesUsed: string[];
    sourcesScraped: string[];
    filesDownloaded: number;
    durationMs: number;
  };
  error?: {
    message: string;
    stack?: string;
    stage: string;
  };
  activityLog?: Array<{
    at: string;
    step: string;
    message: string;
    meta?: Record<string, unknown>;
  }>;
  bullmqJobId?: string;
  /** Set when the job was kicked off via a workflow run. Purely
   *  informational — lets the activity log tell "which workflow
   *  dispatched this" without a reverse lookup. */
  sourceWorkflowId?: mongoose.Types.ObjectId;
  creditsCharged: number;
  /** Denormalized cost rollup — written by the aggregator at job completion
   *  so the detail page reads total + byCategory in O(1) without
   *  re-aggregating CostEvent rows. Authoritative source is still
   *  CostEvent; this is a cache. */
  costSummary?: JobCostSummary;
  subagentStats?: {
    dispatched: number;
    completed: number;
    failed: number;
    timedOut: number;
  };
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const prospectingJobSchema = new Schema<IProspectingJob>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rawQuery: { type: String, required: true, maxlength: 500 },
    // Stored as Mixed — the structured shape is enforced at the API boundary
    // via Zod; Mongoose doesn't add value by re-validating here.
    clarifications: { type: [Schema.Types.Mixed], default: undefined },
    parsedIntent: { type: Schema.Types.Mixed },
    status: { type: String, enum: JOB_STATUSES, default: 'queued' },
    progress: {
      percentage: { type: Number, default: 0 },
      currentStage: { type: String, default: '' },
      stagesComplete: [{ type: String }],
      leadsFoundSoFar: { type: Number, default: 0 },
    },
    result: {
      totalLeadsFound: { type: Number },
      totalAfterDedup: { type: Number },
      dorkQueriesUsed: [{ type: String }],
      sourcesScraped: [{ type: String }],
      filesDownloaded: { type: Number },
      durationMs: { type: Number },
    },
    error: {
      message: { type: String },
      stack: { type: String },
      stage: { type: String },
    },
    activityLog: [
      {
        at: { type: String, required: true },
        step: { type: String, required: true },
        message: { type: String, required: true },
        meta: { type: Schema.Types.Mixed },
      },
    ],
    bullmqJobId: { type: String },
    sourceWorkflowId: { type: Schema.Types.ObjectId, ref: 'Workflow' },
    creditsCharged: { type: Number, default: 0 },
    costSummary: { type: Schema.Types.Mixed },
    subagentStats: {
      dispatched: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      timedOut: { type: Number, default: 0 },
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

prospectingJobSchema.index({ workspaceId: 1 });
prospectingJobSchema.index({ status: 1 });
prospectingJobSchema.index({ createdAt: -1 });
prospectingJobSchema.index({ workspaceId: 1, status: 1 });

export default mongoose.model<IProspectingJob>('ProspectingJob', prospectingJobSchema);
