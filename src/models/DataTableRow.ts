import mongoose, { Schema } from 'mongoose';

/**
 * DataTableRow — one row in a DataTable.
 *
 * `cells` is a Map<columnKey, Cell> where Cell = { value, sources?, filledAt?, filledBy? }.
 * Using Map instead of a plain sub-document because column keys are user-defined
 * and can be added/removed after the table exists — Map's add/remove semantics
 * play cleanly with Mongoose.
 *
 * `primaryKey` enforces uniqueness within a table (compound index below).
 * Semantics by rowType are enforced at the controller layer, not here —
 * Mongo only cares that `(tableId, primaryKey)` is unique.
 *
 * Scale note: rows are capped per-table only by disk. Indexes support
 * keyset pagination (`tableId + _id`) and table-scoped listing by recency
 * (`tableId + updatedAt desc`).
 */

export interface IDataTableRowDoc extends mongoose.Document {
  tableId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  primaryKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cells: Map<string, any>;
  leadId?: mongoose.Types.ObjectId;
  contactId?: mongoose.Types.ObjectId;
  /** Soft-hide — row stays in DB + enrichment-eligible, but is filtered
   *  out of list queries by default. Distinct from delete (permanent).
   *  Enrichment still runs on hidden rows by default so users don't lose
   *  prior work when they unhide later. */
  hidden?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const dataTableRowSchema = new Schema<IDataTableRowDoc>(
  {
    tableId: { type: Schema.Types.ObjectId, ref: 'DataTable', required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    primaryKey: { type: String, required: true, maxlength: 500 },
    cells: { type: Map, of: Schema.Types.Mixed, default: () => new Map() },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Uniqueness — two rows with the same primaryKey in the same table is
// the "duplicate row" error the controller surfaces as 409.
dataTableRowSchema.index({ tableId: 1, primaryKey: 1 }, { unique: true });
// Listing — recent-first within a table.
dataTableRowSchema.index({ tableId: 1, updatedAt: -1 });
// Workspace-scoped lookup for cross-table queries (future: search rows
// across all workspace tables).
dataTableRowSchema.index({ workspaceId: 1, updatedAt: -1 });

export default mongoose.model<IDataTableRowDoc>('DataTableRow', dataTableRowSchema);
