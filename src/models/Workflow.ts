import mongoose, { Schema } from 'mongoose';
import {
  ROW_TYPES,
  COLUMN_VALUE_TYPES,
  WORKFLOW_PARAM_TYPES,
  type RowType,
  type ColumnDef,
  type WorkflowSeed,
} from '../../shared/index.js';

/**
 * Workflow — a reusable table template + optional agent seed query.
 *
 * Phase 11 M1. Running a workflow produces a fresh DataTable with the
 * stored column definitions, and if `seed` is present, dispatches a
 * prospecting job targeted at that new table.
 *
 * This is a *stored configuration* — no runtime of its own. The runtime
 * is the existing data-table + prospecting-job + enrichment pipeline.
 *
 * `origin: 'local'` is the only supported value in v1. M2 adds
 * `{ kind: 'installed', shareId, publishedBy }` for the shareable flow.
 */

export interface IWorkflowDoc extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  tags: string[];
  tableTemplate: {
    rowType: RowType;
    columns: ColumnDef[];
    defaultTableNameTemplate?: string;
  };
  seed?: WorkflowSeed;
  origin: 'local' | 'installed';
  stats: {
    timesRun: number;
    lastRunAt?: Date;
  };
  /** Phase 11 M2 — set when the workflow is published. URL-safe random
   *  32-char token; sparse-unique-indexed so multiple unpublished
   *  workflows don't collide on `null`. */
  shareToken?: string;
  publishedAt?: Date;
  publishStats?: { installs: number; lastInstalledAt?: Date };
  /** Phase 11 M2 — only present when origin === 'installed'. Preserves
   *  the agency provenance so the dashboard can show "from X" badges. */
  installedFrom?: {
    shareToken: string;
    sourceWorkflowId: mongoose.Types.ObjectId;
    sourceWorkspaceId: mongoose.Types.ObjectId;
    publishedBy: mongoose.Types.ObjectId;
    installedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

// Reuse the same shape the DataTable model uses for columns — they
// share the `ColumnDef` type so runtime objects interoperate without
// transformation.
const columnDefSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 80 },
    label: { type: String, required: true, maxlength: 120 },
    type: { type: String, enum: COLUMN_VALUE_TYPES, required: true },
    definition: { type: Schema.Types.Mixed, default: { type: 'static' } },
    width: { type: Number, min: 40, max: 800 },
    pinned: { type: Boolean },
    hidden: { type: Boolean },
  },
  { _id: false },
);

const seedParamSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 40 },
    label: { type: String, required: true, maxlength: 120 },
    type: { type: String, enum: WORKFLOW_PARAM_TYPES, required: true },
    defaultValue: { type: Schema.Types.Mixed },
    options: { type: [String] },
    required: { type: Boolean, default: false },
  },
  { _id: false },
);

const seedSchema = new Schema(
  {
    rawQueryTemplate: { type: String, required: true, maxlength: 4000 },
    parameters: { type: [seedParamSchema], default: [] },
  },
  { _id: false },
);

const tableTemplateSchema = new Schema(
  {
    rowType: { type: String, enum: ROW_TYPES, required: true },
    columns: { type: [columnDefSchema], default: [] },
    defaultTableNameTemplate: { type: String, maxlength: 240 },
  },
  { _id: false },
);

const statsSchema = new Schema(
  {
    timesRun: { type: Number, default: 0, min: 0 },
    lastRunAt: { type: Date },
  },
  { _id: false },
);

const installedFromSchema = new Schema(
  {
    shareToken: { type: String, required: true },
    sourceWorkflowId: { type: Schema.Types.ObjectId, required: true },
    sourceWorkspaceId: { type: Schema.Types.ObjectId, required: true },
    publishedBy: { type: Schema.Types.ObjectId, required: true },
    installedAt: { type: Date, required: true },
  },
  { _id: false },
);

const publishStatsSchema = new Schema(
  {
    installs: { type: Number, default: 0, min: 0 },
    lastInstalledAt: { type: Date },
  },
  { _id: false },
);

const workflowSchema = new Schema<IWorkflowDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 1000 },
    tags: { type: [String], default: [] },
    tableTemplate: { type: tableTemplateSchema, required: true },
    seed: { type: seedSchema },
    origin: { type: String, enum: ['local', 'installed'], default: 'local' },
    stats: { type: statsSchema, default: () => ({ timesRun: 0 }) },
    shareToken: { type: String },
    publishedAt: { type: Date },
    publishStats: { type: publishStatsSchema },
    installedFrom: { type: installedFromSchema },
  },
  { timestamps: true },
);

workflowSchema.index({ workspaceId: 1, updatedAt: -1 });
// Sparse-unique on shareToken so unpublished docs (null token) don't
// collide. The public install lookup hits this index directly.
workflowSchema.index({ shareToken: 1 }, { unique: true, sparse: true });

export default mongoose.model<IWorkflowDoc>('Workflow', workflowSchema);
