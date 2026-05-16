import mongoose, { Schema } from 'mongoose';
import {
  ROW_TYPES,
  COLUMN_VALUE_TYPES,
  type RowType,
  type ColumnDef,
} from '../../shared/index.js';

/**
 * DataTable — the Clay-parity primitive.
 *
 * Table definition only (name, row type, columns). Rows live in the
 * `datatablerows` collection, keyed by `tableId`. `rowCount` is
 * denormalized here for the listing page — updated on every bulk add.
 *
 * Columns carry their `definition` inline on the table document.
 * Definition changes (e.g. switching a column from static to enriched)
 * rewrite the table doc but do NOT touch existing row cells — prior
 * cell values simply don't get re-filled until an explicit enrichment
 * run (Phase 15D).
 */

export interface IDataTableDoc extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  rowType: RowType;
  columns: ColumnDef[];
  sourceJobId?: mongoose.Types.ObjectId;
  tags: string[];
  rowCount: number;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Subschema for columns. We store `definition` as Mixed because the
// discriminated union of `{type:'static'}` | `{type:'enriched', ...}`
// is awkward in Mongoose; validation at the API boundary (Zod) is the
// single source of truth.
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

const dataTableSchema = new Schema<IDataTableDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 1000 },
    rowType: { type: String, enum: ROW_TYPES, required: true },
    columns: { type: [columnDefSchema], default: [] },
    sourceJobId: { type: Schema.Types.ObjectId, ref: 'ProspectingJob' },
    tags: { type: [String], default: [] },
    rowCount: { type: Number, default: 0, min: 0 },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);

dataTableSchema.index({ workspaceId: 1, updatedAt: -1 });
dataTableSchema.index({ workspaceId: 1, archivedAt: 1, updatedAt: -1 });

export default mongoose.model<IDataTableDoc>('DataTable', dataTableSchema);
