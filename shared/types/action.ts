import type { RowType, ColumnValueType } from './dataTable.js';

/**
 * DataSourceAction — a curated, user-facing "recipe" that wraps a data
 * source + input heuristics + output definition into a one-click
 * enrichment.
 *
 * Actions are platform-curated (defined in shared/src/actions/catalog.ts)
 * rather than source-contributed. This keeps the catalog discoverable,
 * small, and lets us control UX quality.
 *
 * Underneath, an action just writes the same
 * `column.definition = {type: 'enriched', sourceId, inputMappings, outputPath}`
 * the per-column Connect flow produces, and dispatches the same
 * enrichment worker. The action layer is pure UX sugar — it's the 80%
 * case made simple.
 */

export type ActionCategory = 'verify' | 'find' | 'enrich';

export interface ActionInputSpec {
  /** Key of the input field on the underlying DataSource.
   *  Maps to a key in the source's `input.describe[].key`. */
  sourceInputKey: string;
  /** Human label for this input, shown in the action modal. */
  label: string;
  required: boolean;
  /** When auto-detecting which column of the table provides this input,
   *  prefer columns whose type is in this list. */
  matchColumnTypes?: ColumnValueType[];
  /** Or columns whose key matches one of these regex strings
   *  (case-insensitive). Matched in order — first match wins. */
  matchColumnKeyPatterns?: string[];
  /** Optional hint shown under the input's picker. */
  hint?: string;
}

export interface ActionOutputSpec {
  /** Default key for the created column. User can rename in the modal. */
  defaultKey: string;
  defaultLabel: string;
  type: ColumnValueType;
  /** JSONPath into the data source's output (e.g. "person.title",
   *  "organization.technologyNames"). Matches the underlying
   *  column.definition.outputPath shape. */
  outputPath: string;
}

export interface DataSourceAction {
  id: string;
  label: string;
  description: string;
  category: ActionCategory;
  /** Which table rowTypes this action is applicable to. */
  rowTypes: RowType[];
  /** Which DataSource backs this action (e.g. 'zerobounce.verify'). */
  sourceId: string;
  /** Display name of the backing source — used in the UI so users see
   *  "Powered by ZeroBounce" without a separate registry lookup. */
  sourceDisplayName: string;
  inputs: ActionInputSpec[];
  /** v1: each action defines one output (= one column). v1.1 will
   *  add multi-output support (one source call → N cells across N
   *  columns) via a single-flight cache in the enrichment worker. */
  output: ActionOutputSpec;
}
