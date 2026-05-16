import mongoose from 'mongoose';
import DataTable from '../../models/DataTable.js';
import DataTableRow from '../../models/DataTableRow.js';
import { getDataSource } from '../data-sources/registry.js';
import { runDataSource } from '../data-sources/executor.js';
import type { ColumnDef } from '../../../shared/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';

/**
 * Phase 15D — column-referenced enrichment.
 *
 * Takes a column with `definition.type === 'enriched'`, resolves its
 * `inputMappings` from each row's cells, invokes the bound data source
 * via the executor, extracts the output at `outputPath`, and writes
 * the result back as a typed Cell (value + invocationId + sourceUrl
 * when derivable).
 *
 * Executor already handles: credentials, rate limits, cost events,
 * invocation log. This service is the table-specific glue.
 */

// ── Input resolution ───────────────────────────────────────────────

/**
 * Resolves a single column's `inputMappings` against a row. Returns the
 * object that gets passed to `runDataSource`. Returns null if required
 * inputs can't be resolved — caller logs and skips the row.
 */
export function resolveInput(params: {
  column: ColumnDef;
  row: { primaryKey: string; cells: Map<string, unknown> | Record<string, unknown> };
}): Record<string, unknown> | null {
  const { column, row } = params;
  if (column.definition?.type !== 'enriched') return null;
  const mappings = column.definition.inputMappings ?? {};

  const cells = row.cells instanceof Map
    ? Object.fromEntries(row.cells.entries())
    : row.cells;

  const out: Record<string, unknown> = {};
  for (const [sourceField, ref] of Object.entries(mappings)) {
    if (!ref || typeof ref !== 'object') continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = ref as any;
    switch (r.kind) {
      case 'literal':
        out[sourceField] = r.value;
        break;
      case 'row_type_id':
        out[sourceField] = row.primaryKey;
        break;
      case 'column': {
        const key = String(r.key);
        const cell = cells[key];
        // Cell values are either raw primitives (seed-from-job path) or
        // wrapped { value, sources, ... } shapes (service.ts::wrapCells).
        // Unwrap if wrapped.
        const value =
          cell && typeof cell === 'object' && 'value' in (cell as Record<string, unknown>)
            ? (cell as { value: unknown }).value
            : cell;
        if (value === undefined || value === null || value === '') {
          // Required input missing — surface to caller to decide skip vs. partial.
          return null;
        }
        out[sourceField] = value;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ── Output extraction ──────────────────────────────────────────────

/**
 * Resolves a dotted path (e.g. "person.primary_email" or
 * "organization.technologyNames[0]") against an arbitrary output object.
 * Keeps deliberately narrow — supports `a.b.c` and `a[0].b` only. No
 * wildcards, no slicing, no expressions. Anything more is a Phase 11
 * (saved workflows) / v2-formula surface.
 */
export function extractAtPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const tokens: string[] = [];
  let buf = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]!;
    if (ch === '.') {
      if (buf) { tokens.push(buf); buf = ''; }
    } else if (ch === '[') {
      if (buf) { tokens.push(buf); buf = ''; }
      const end = path.indexOf(']', i);
      if (end === -1) return undefined;
      tokens.push(path.slice(i + 1, end));
      i = end;
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);

  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (/^\d+$/.test(t)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(t)];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur;
}

// ── Single-row enrichment ─────────────────────────────────────────

/**
 * Runs one column's enrichment against one row. Returns a result that
 * includes the extracted value + invocation metadata for cell provenance.
 */
export async function enrichOne(params: {
  workspaceId: string;
  tableId: string;
  rowId: string;
  columnKey: string;
}): Promise<{
  status: 'success' | 'failed' | 'rate_limited' | 'auth_failed' | 'invalid_input' | 'skipped';
  invocationId?: string;
  value?: unknown;
  errorMessage?: string;
}> {
  const { workspaceId, tableId, rowId, columnKey } = params;

  const table = await DataTable.findOne({ _id: tableId, workspaceId });
  if (!table) throw ApiError.notFound('Table not found');

  const column = table.columns.find((c) => c.key === columnKey);
  if (!column) throw ApiError.notFound(`Column "${columnKey}" not found`);
  if (column.definition?.type !== 'enriched') {
    throw ApiError.badRequest(`Column "${columnKey}" is not configured for enrichment`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = column.definition as any;
  const sourceId = String(def.sourceId ?? '');
  const outputPath = String(def.outputPath ?? '');
  if (!sourceId) throw ApiError.badRequest(`Column "${columnKey}" has no sourceId`);

  const ds = getDataSource(sourceId);
  if (!ds) throw ApiError.badRequest(`Unknown data source: ${sourceId}`);

  const row = await DataTableRow.findOne({ _id: rowId, tableId, workspaceId });
  if (!row) throw ApiError.notFound('Row not found');

  const input = resolveInput({
    column,
    row: { primaryKey: row.primaryKey, cells: row.cells },
  });
  if (!input) {
    // Required input missing — skip silently, not an error.
    return { status: 'skipped', errorMessage: 'Missing required input from referenced columns' };
  }

  const result = await runDataSource(sourceId, input, {
    workspaceId,
    triggeredBy: 'manual',
    tableRowId: rowId,
    columnKey,
    ...(def.credentialId ? { credentialId: String(def.credentialId) } : {}),
  });

  if (result.status !== 'success') {
    // Still record an invocation (the executor did that); return the classified status.
    return {
      status: result.status as 'failed' | 'rate_limited' | 'auth_failed' | 'invalid_input',
      invocationId: result.invocationId,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  }

  // Extract the cell value from the source's output via outputPath.
  const extracted = outputPath ? extractAtPath(result.output, outputPath) : result.output;

  // Cell provenance: pull a source URL if one lives at `.sourceUrl` or
  // `.raw.sourceUrl` in the provider payload. Safe no-op if absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = result.output as any;
  const derivedSourceUrl =
    typeof out?.sourceUrl === 'string' ? out.sourceUrl :
    typeof out?.source_url === 'string' ? out.source_url :
    undefined;

  const cellSource = {
    dataSourceId: sourceId,
    invocationId: result.invocationId,
    ...(derivedSourceUrl ? { sourceUrl: derivedSourceUrl } : {}),
    scrapedAt: new Date().toISOString(),
  };

  const wrappedCell = {
    value: extracted ?? null,
    sources: [cellSource],
    filledAt: new Date().toISOString(),
    filledBy: 'data_source' as const,
  };

  // $set on Map path — only this cell is touched.
  await DataTableRow.updateOne(
    { _id: rowId },
    { $set: { [`cells.${columnKey}`]: wrappedCell } },
  );

  return {
    status: 'success',
    invocationId: result.invocationId,
    value: extracted,
  };
}

// ── Batch — enqueue one sub-job per row ──────────────────────────

/**
 * Dry-run: how many rows would this column fill if we ran it right
 * now? Takes `skipExisting` (default true) to match what the worker
 * does — only rows where the cell is currently empty get enriched.
 */
export async function estimateEnrichment(params: {
  workspaceId: string;
  tableId: string;
  columnKey: string;
  skipExisting?: boolean;
  rowIds?: string[];
}): Promise<{
  rowsSelected: number;
  rowsWithResolvableInputs: number;
  rowsAlreadyFilled: number;
  rowsMissingInputs: number;
  estimatedCostUSD: number;
}> {
  const { workspaceId, tableId, columnKey } = params;
  const skipExisting = params.skipExisting ?? true;

  const table = await DataTable.findOne({ _id: tableId, workspaceId });
  if (!table) throw ApiError.notFound('Table not found');
  const column = table.columns.find((c) => c.key === columnKey);
  if (!column) throw ApiError.notFound(`Column "${columnKey}" not found`);
  if (column.definition?.type !== 'enriched') {
    throw ApiError.badRequest(`Column "${columnKey}" is not configured for enrichment`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = column.definition as any;
  const sourceId = String(def.sourceId ?? '');
  const ds = getDataSource(sourceId);
  const perCall = ds?.pricing.providerCostUSDPerCall ?? 0;

  const rowFilter: Record<string, unknown> = { tableId: new mongoose.Types.ObjectId(tableId) };
  if (params.rowIds?.length) {
    rowFilter['_id'] = { $in: params.rowIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const rows = await DataTableRow.find(rowFilter).lean();

  let rowsAlreadyFilled = 0;
  let rowsMissingInputs = 0;
  let rowsWithResolvableInputs = 0;

  for (const row of rows) {
    const cells = asCellsRecord(row.cells);
    const existing = cells[columnKey];
    const hasValue =
      existing !== undefined && existing !== null &&
      (typeof existing !== 'object' ||
        (existing !== null && 'value' in (existing as Record<string, unknown>) &&
         (existing as { value?: unknown }).value !== null &&
         (existing as { value?: unknown }).value !== undefined));

    if (skipExisting && hasValue) {
      rowsAlreadyFilled += 1;
      continue;
    }

    const resolved = resolveInput({
      column,
      row: { primaryKey: row.primaryKey, cells: row.cells as Map<string, unknown> | Record<string, unknown> },
    });
    if (!resolved) {
      rowsMissingInputs += 1;
      continue;
    }
    rowsWithResolvableInputs += 1;
  }

  return {
    rowsSelected: rows.length,
    rowsWithResolvableInputs,
    rowsAlreadyFilled,
    rowsMissingInputs,
    estimatedCostUSD: rowsWithResolvableInputs * perCall,
  };
}

/**
 * Kick-off — enqueues one BullMQ job per row. Returns the parent run
 * id (a UUID-ish string derived from table+column+timestamp) that
 * downstream polling / progress SSE can key off.
 */
export async function dispatchEnrichment(params: {
  workspaceId: string;
  tableId: string;
  columnKey: string;
  skipExisting?: boolean;
  rowIds?: string[];
}): Promise<{ enrichmentRunId: string; jobsEnqueued: number }> {
  const { workspaceId, tableId, columnKey } = params;
  const skipExisting = params.skipExisting ?? true;

  const table = await DataTable.findOne({ _id: tableId, workspaceId });
  if (!table) throw ApiError.notFound('Table not found');
  const column = table.columns.find((c) => c.key === columnKey);
  if (!column) throw ApiError.notFound(`Column "${columnKey}" not found`);
  if (column.definition?.type !== 'enriched') {
    throw ApiError.badRequest(`Column "${columnKey}" is not configured for enrichment`);
  }

  const rowFilter: Record<string, unknown> = { tableId: new mongoose.Types.ObjectId(tableId) };
  if (params.rowIds?.length) {
    rowFilter['_id'] = { $in: params.rowIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await DataTableRow.find(rowFilter).select('_id cells primaryKey').lean() as any[];

  const enrichmentRunId = `${tableId}-${columnKey}-${Date.now()}`;

  // Filter rows to only those that actually need a job — skip-existing
  // and missing-input rows would make jobs that immediately return skipped.
  // Cheaper to filter up front.
  const toEnqueue: Array<{ rowId: string }> = [];
  for (const row of rows) {
    const cells = asCellsRecord(row.cells);
    const existing = cells[columnKey];
    const hasValue =
      existing !== undefined && existing !== null &&
      (typeof existing !== 'object' ||
        (existing !== null && 'value' in (existing as Record<string, unknown>) &&
         (existing as { value?: unknown }).value !== null &&
         (existing as { value?: unknown }).value !== undefined));
    if (skipExisting && hasValue) continue;
    const resolved = resolveInput({
      column,
      row: { primaryKey: row.primaryKey, cells: row.cells },
    });
    if (!resolved) continue;
    toEnqueue.push({ rowId: String(row._id) });
  }

  if (toEnqueue.length === 0) {
    return { enrichmentRunId, jobsEnqueued: 0 };
  }

  const { getTableEnrichmentQueue } = await import('../queue/queues.js');
  const queue = getTableEnrichmentQueue();

  await queue.addBulk(
    toEnqueue.map((r) => ({
      name: 'enrich-cell',
      data: {
        workspaceId,
        tableId,
        columnKey,
        rowId: r.rowId,
        enrichmentRunId,
      },
      // jobId per (run, row) so re-adding is idempotent. Separator must be
      // '-' not ':' — BullMQ reserves colons as Redis key separators and
      // rejects them in custom job IDs. Column keys are snake_case and
      // ObjectIds are hex, so '-' is unambiguous here.
      opts: { jobId: `${enrichmentRunId}-${r.rowId}` },
    })),
  );

  logger.info('[data-tables] enrichment dispatched', {
    workspaceId, tableId, columnKey, jobsEnqueued: toEnqueue.length, enrichmentRunId,
  });

  return { enrichmentRunId, jobsEnqueued: toEnqueue.length };
}

// ── Helpers ───────────────────────────────────────────────────────

function asCellsRecord(cells: unknown): Record<string, unknown> {
  if (cells instanceof Map) return Object.fromEntries(cells.entries());
  if (cells && typeof cells === 'object') return cells as Record<string, unknown>;
  return {};
}
