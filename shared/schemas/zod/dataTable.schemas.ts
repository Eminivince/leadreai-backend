import { z } from 'zod';

/**
 * Data Table primitive — Phase 15C.
 *
 * A DataTable is a flexible, user-defined, typed spreadsheet. Rows have
 * a type (`company` | `person` | `url` | `custom`) that determines the
 * primary-key semantics. Columns are fully user-defined with a value
 * type + optional `definition` that tells the 15D enrichment layer how
 * to fill each cell.
 *
 * This is the Clay-parity primitive — "a spreadsheet where each column
 * can come from a different data source." v1 is static + one-source-per-
 * column (via the `enriched` column definition shape below). Waterfalls
 * and column-reference formulas land in v2 / v3 per goal.md decisions
 * #4 and #5.
 *
 * Agent-produced `Lead` records project into a `company`-type table when
 * a job targets a table (see ProspectingJob.target field added in this
 * phase). The Lead remains the agent's native output; the DataTableRow
 * is a second projection that carries column-level evidence.
 */

// ── Row types ────────────────────────────────────────────────────────

export const ROW_TYPES = ['company', 'person', 'url', 'custom'] as const;
export const RowTypeSchema = z.enum(ROW_TYPES);
export type RowType = z.infer<typeof RowTypeSchema>;

// ── Column definitions ───────────────────────────────────────────────

export const COLUMN_VALUE_TYPES = [
  'text',
  'number',
  'currency',
  'percentage',
  'date',
  'url',
  'email',
  'phone',
  'tags',
  'boolean',
] as const;
export const ColumnValueTypeSchema = z.enum(COLUMN_VALUE_TYPES);
export type ColumnValueType = z.infer<typeof ColumnValueTypeSchema>;

/**
 * How a column's cells are filled. v1 shapes:
 *   - `static`: the user (or agent's `write_lead`) writes the cell value directly.
 *   - `enriched`: the cell is filled by invoking a DataSource with the
 *     configured input mappings. 15D lands `inputMappings` semantics;
 *     15C only carries the shape so tables can be created with
 *     enrichment-intent columns that 15D will later activate.
 */
export const ColumnInputRefSchema = z.union([
  z.object({ kind: z.literal('column'), key: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('literal'), value: z.string().max(2000) }),
  z.object({ kind: z.literal('row_type_id') }),
]);

export const ColumnDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('static') }),
  z.object({
    type: z.literal('enriched'),
    sourceId: z.string().min(1).max(100),
    credentialId: z.string().optional(),
    /** Keyed by the DataSource's input field key. Empty in 15C; 15D
     *  requires non-empty when the column is actually run. */
    inputMappings: z.record(z.string(), ColumnInputRefSchema).default({}),
    /** JSONPath-like selector into the DataSource's output shape — the
     *  extracted value becomes this column's cell. */
    outputPath: z.string().max(200).default(''),
  }),
]);

export const ColumnDefSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase snake_case').max(80),
  label: z.string().min(1).max(120),
  type: ColumnValueTypeSchema,
  definition: ColumnDefinitionSchema.default({ type: 'static' }),
  width: z.number().int().min(40).max(800).optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
});
export type ColumnDef = z.infer<typeof ColumnDefSchema>;

// ── Cells + provenance ───────────────────────────────────────────────

export const CellSourceSchema = z.object({
  dataSourceId: z.string().optional(),
  invocationId: z.string().optional(),
  sourceUrl: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  scrapedAt: z.string().optional(),
});

export const CellSchema = z.object({
  value: z.unknown().nullable(),
  sources: z.array(CellSourceSchema).optional(),
  filledAt: z.string().optional(),
  filledBy: z.enum(['agent', 'manual', 'data_source', 'system', 'import']).optional(),
});
export type Cell = z.infer<typeof CellSchema>;

// ── Table document ───────────────────────────────────────────────────

export const DataTableSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  createdBy: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  rowType: RowTypeSchema,
  columns: z.array(ColumnDefSchema),
  sourceJobId: z.string().optional(),
  tags: z.array(z.string().max(40)).default([]),
  rowCount: z.number().int().nonnegative().default(0),
  archivedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DataTable = z.infer<typeof DataTableSchema>;

export const CreateDataTableSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  rowType: RowTypeSchema,
  columns: z.array(ColumnDefSchema).default([]),
  tags: z.array(z.string().max(40)).optional(),
});
export type CreateDataTableInput = z.infer<typeof CreateDataTableSchema>;

export const UpdateDataTableSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).optional(),
  archived: z.boolean().optional(),
});
export type UpdateDataTableInput = z.infer<typeof UpdateDataTableSchema>;

// ── Row shape ────────────────────────────────────────────────────────

export const DataTableRowSchema = z.object({
  _id: z.string(),
  tableId: z.string(),
  workspaceId: z.string(),
  primaryKey: z.string().min(1).max(500),
  cells: z.record(z.string(), CellSchema).default({}),
  leadId: z.string().optional(),
  contactId: z.string().optional(),
  hidden: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DataTableRow = z.infer<typeof DataTableRowSchema>;

/**
 * Row-add payload. `primaryKey` defines uniqueness within the table;
 * semantics by rowType:
 *   - company: companyDomain (preferred) | normalized-company-name
 *   - person: email | linkedinUrl | "firstName lastName@company"
 *   - url: the URL itself
 *   - custom: any non-empty string the user provides
 *
 * Duplicate primaryKey within the same table is rejected (409).
 */
export const AddRowInputSchema = z.object({
  primaryKey: z.string().min(1).max(500),
  cells: z.record(z.string(), z.unknown()).optional(),
  leadId: z.string().optional(),
  contactId: z.string().optional(),
});

export const AddRowsBulkInputSchema = z.object({
  rows: z.array(AddRowInputSchema).min(1).max(1000),
});

export const UpdateRowInputSchema = z.object({
  // Cell values to set. Missing columns are untouched; sending `null`
  // clears a cell. Unknown column keys 400.
  cells: z.record(z.string(), z.unknown()).optional(),
  /** Soft-hide the row (true) or restore it (false). Omit to not change. */
  hidden: z.boolean().optional(),
}).refine(
  (d) => d.cells !== undefined || d.hidden !== undefined,
  { message: 'At least one of cells or hidden must be provided' },
);

/** Bulk row mutation — used by the action bar in the grid UI. */
export const BulkRowActionSchema = z.object({
  rowIds: z.array(z.string()).min(1).max(500),
  action: z.enum(['hide', 'unhide', 'delete']),
});

// ── Column management ────────────────────────────────────────────────

export const AddColumnInputSchema = ColumnDefSchema;
export const UpdateColumnInputSchema = ColumnDefSchema.partial().extend({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase snake_case').max(80),
});

export type AddRowInput = z.infer<typeof AddRowInputSchema>;
export type UpdateRowInput = z.infer<typeof UpdateRowInputSchema>;
export type AddColumnInput = z.infer<typeof AddColumnInputSchema>;
export type UpdateColumnInput = z.infer<typeof UpdateColumnInputSchema>;
