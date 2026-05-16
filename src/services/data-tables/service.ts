import mongoose from 'mongoose';
import DataTable, { type IDataTableDoc } from '../../models/DataTable.js';
import DataTableRow from '../../models/DataTableRow.js';
import Lead from '../../models/Lead.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import type { ColumnDef, RowType } from '../../../shared/index.js';

/**
 * Service-layer helpers for tables and rows. Controllers stay thin —
 * they validate payloads and delegate here for cross-collection work
 * (row upserts that touch table.rowCount, seed-from-job that projects
 * Leads into rows, etc.).
 */

// ── Column validation ──────────────────────────────────────────────

/**
 * Asserts `cells` references only columns that exist on the table.
 * Unknown keys become a 400 — prevents typos silently persisting as
 * "ghost columns" that nothing ever reads.
 */
export function assertCellKeysKnown(table: IDataTableDoc, cells: Record<string, unknown>): void {
  const known = new Set(table.columns.map((c) => c.key));
  const unknown = Object.keys(cells).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw ApiError.badRequest(`Unknown column key(s): ${unknown.join(', ')}`);
  }
}

export function assertColumnKeyAvailable(table: IDataTableDoc, key: string): void {
  if (table.columns.some((c) => c.key === key)) {
    throw ApiError.badRequest(`Column "${key}" already exists on this table`);
  }
}

// ── Row helpers ────────────────────────────────────────────────────

/**
 * Wraps raw cell values with the `Cell` shape (value + filledBy + filledAt).
 * Existing `sources[]` from AI-produced rows is preserved when passed
 * already wrapped; callers passing plain primitives get `filledBy:'manual'`.
 */
export function wrapCells(
  cells: Record<string, unknown>,
  filledBy: 'agent' | 'manual' | 'data_source' | 'system' | 'import',
): Record<string, unknown> {
  const now = new Date().toISOString();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cells)) {
    // Pass through already-wrapped cells (from agent's write_lead projection)
    if (
      value !== null &&
      typeof value === 'object' &&
      'value' in (value as Record<string, unknown>)
    ) {
      out[key] = value;
    } else {
      out[key] = { value, filledAt: now, filledBy };
    }
  }
  return out;
}

/**
 * Insert rows and recompute the table's denormalized rowCount. Uses
 * insertMany + {ordered:false} so dup-primaryKey conflicts don't kill
 * the whole batch — returns counts for success/conflict/error.
 */
export async function bulkAddRows(params: {
  table: IDataTableDoc;
  workspaceId: string;
  rows: Array<{
    primaryKey: string;
    cells?: Record<string, unknown>;
    leadId?: string;
    contactId?: string;
  }>;
  filledBy: 'agent' | 'manual' | 'data_source' | 'system' | 'import';
}): Promise<{ inserted: number; duplicates: number; errors: number }> {
  const { table, workspaceId, rows, filledBy } = params;

  for (const r of rows) {
    if (r.cells) assertCellKeysKnown(table, r.cells);
  }

  const docs = rows.map((r) => ({
    tableId: table._id,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    primaryKey: r.primaryKey,
    cells: r.cells ? wrapCells(r.cells, filledBy) : {},
    ...(r.leadId && mongoose.Types.ObjectId.isValid(r.leadId)
      ? { leadId: new mongoose.Types.ObjectId(r.leadId) }
      : {}),
    ...(r.contactId && mongoose.Types.ObjectId.isValid(r.contactId)
      ? { contactId: new mongoose.Types.ObjectId(r.contactId) }
      : {}),
  }));

  let inserted = 0;
  let duplicates = 0;
  let errors = 0;

  try {
    const result = await DataTableRow.insertMany(docs, { ordered: false });
    inserted = result.length;
  } catch (err) {
    // BulkWriteError: some succeeded, some failed. We still count successes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bulkErr = err as any;
    inserted = bulkErr?.insertedDocs?.length ?? bulkErr?.result?.insertedCount ?? 0;
    const writeErrors: Array<{ code?: number }> = bulkErr?.writeErrors ?? [];
    for (const w of writeErrors) {
      if (w.code === 11000) duplicates += 1;
      else errors += 1;
    }
    if (errors > 0) {
      logger.warn('[data-tables] bulkAddRows had non-duplicate errors', {
        tableId: String(table._id),
        errors,
        sample: writeErrors.slice(0, 3),
      });
    }
  }

  if (inserted > 0) {
    await DataTable.updateOne({ _id: table._id }, { $inc: { rowCount: inserted } });
  }

  return { inserted, duplicates, errors };
}

// ── Seed from job ──────────────────────────────────────────────────

/**
 * Projects a completed prospecting job's leads into a company-type
 * DataTable. One row per non-duplicate Lead. Cells map to any columns
 * whose key matches a standard Lead field.
 *
 * Standard company columns (auto-mapped if the table defines them):
 *   company_name, company_domain, website, industry, country, city,
 *   rank_score, primary_email, primary_phone, top_contact_name,
 *   top_contact_title, top_contact_email.
 *
 * Unknown columns on the table are left empty — enrichable later via
 * 15D. The job's `parentJobId` is stored on `DataTable.sourceJobId`
 * for audit.
 */
export async function seedTableFromJob(params: {
  table: IDataTableDoc;
  workspaceId: string;
  jobId: string;
  limit?: number;
}): Promise<{ inserted: number; skipped: number; duplicates: number }> {
  const { table, workspaceId, jobId } = params;
  const limit = params.limit ?? 1000;

  if (table.rowType !== 'company') {
    throw ApiError.badRequest('seedTableFromJob supports rowType="company" only (v1)');
  }

  const leads = await Lead
    .find({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      jobId: new mongoose.Types.ObjectId(jobId),
      isDuplicate: { $ne: true },
    })
    .sort({ rankScore: -1 })
    .limit(limit)
    .lean();

  if (leads.length === 0) {
    return { inserted: 0, skipped: 0, duplicates: 0 };
  }

  const columnKeys = new Set(table.columns.map((c) => c.key));
  const mappedRows = leads.map((l) => {
    const cells: Record<string, unknown> = {};
    // Auto-populate any column whose key matches a standard projection.
    // Fields only land when the table actually has a column for them.
    maybeSet(cells, columnKeys, 'company_name', l.companyName);
    maybeSet(cells, columnKeys, 'company_domain', l.companyDomain);
    maybeSet(cells, columnKeys, 'website', l.website);
    maybeSet(cells, columnKeys, 'industry', l.industry);
    maybeSet(cells, columnKeys, 'country', l.address?.country);
    maybeSet(cells, columnKeys, 'city', l.address?.city);
    maybeSet(cells, columnKeys, 'rank_score', l.rankScore);
    // Emails/phones — pick the highest-confidence entry
    const primaryEmail = pickPrimaryEmail(l.emails);
    const primaryPhone = pickPrimaryPhone(l.phones);
    maybeSet(cells, columnKeys, 'primary_email', primaryEmail);
    maybeSet(cells, columnKeys, 'primary_phone', primaryPhone);
    // Top contact (from contactSummary if populated by pipeline)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (l as any).contactSummary?.topContact;
    maybeSet(cells, columnKeys, 'top_contact_name', cs?.fullName);
    maybeSet(cells, columnKeys, 'top_contact_title', cs?.title);
    maybeSet(cells, columnKeys, 'top_contact_email', cs?.primaryEmail);

    const pk =
      (typeof l.companyDomain === 'string' && l.companyDomain.trim()) ||
      (typeof l.companyName === 'string' && l.companyName.trim()) ||
      String(l._id);

    return {
      primaryKey: pk,
      cells,
      leadId: String(l._id),
    };
  });

  const result = await bulkAddRows({
    table,
    workspaceId,
    rows: mappedRows,
    filledBy: 'agent',
  });

  // Mark the table's source job for audit if not already set.
  if (!table.sourceJobId) {
    await DataTable.updateOne(
      { _id: table._id },
      { $set: { sourceJobId: new mongoose.Types.ObjectId(jobId) } },
    );
  }

  return {
    inserted: result.inserted,
    skipped: result.errors,
    duplicates: result.duplicates,
  };
}

// ── Internal helpers ───────────────────────────────────────────────

function maybeSet(
  out: Record<string, unknown>,
  known: Set<string>,
  key: string,
  value: unknown,
): void {
  if (!known.has(key)) return;
  if (value === undefined || value === null || value === '') return;
  out[key] = value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickPrimaryEmail(emails: any): string | undefined {
  if (!Array.isArray(emails) || emails.length === 0) return undefined;
  const sorted = [...emails].sort((a, b) => {
    const ta = (a?.type === 'business' ? 1 : 0) - (b?.type === 'business' ? 1 : 0);
    if (ta !== 0) return -ta;
    return (b?.confidence ?? 0) - (a?.confidence ?? 0);
  });
  return typeof sorted[0]?.address === 'string' ? sorted[0].address : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickPrimaryPhone(phones: any): string | undefined {
  if (!Array.isArray(phones) || phones.length === 0) return undefined;
  return typeof phones[0]?.normalized === 'string'
    ? phones[0].normalized
    : typeof phones[0]?.raw === 'string'
      ? phones[0].raw
      : undefined;
}

// ── Suggested starter columns (used by UI later) ──────────────────

export function defaultColumnsFor(rowType: RowType): ColumnDef[] {
  if (rowType === 'company') {
    return [
      { key: 'company_name', label: 'Company', type: 'text', definition: { type: 'static' } },
      { key: 'company_domain', label: 'Domain', type: 'url', definition: { type: 'static' } },
      { key: 'industry', label: 'Industry', type: 'text', definition: { type: 'static' } },
      { key: 'country', label: 'Country', type: 'text', definition: { type: 'static' } },
      { key: 'primary_email', label: 'Email', type: 'email', definition: { type: 'static' } },
      { key: 'primary_phone', label: 'Phone', type: 'phone', definition: { type: 'static' } },
      { key: 'top_contact_name', label: 'Top contact', type: 'text', definition: { type: 'static' } },
      { key: 'top_contact_title', label: 'Title', type: 'text', definition: { type: 'static' } },
    ];
  }
  if (rowType === 'person') {
    return [
      { key: 'full_name', label: 'Name', type: 'text', definition: { type: 'static' } },
      { key: 'email', label: 'Email', type: 'email', definition: { type: 'static' } },
      { key: 'title', label: 'Title', type: 'text', definition: { type: 'static' } },
      { key: 'company', label: 'Company', type: 'text', definition: { type: 'static' } },
      { key: 'linkedin_url', label: 'LinkedIn', type: 'url', definition: { type: 'static' } },
    ];
  }
  if (rowType === 'url') {
    return [
      { key: 'url', label: 'URL', type: 'url', definition: { type: 'static' } },
      { key: 'title', label: 'Title', type: 'text', definition: { type: 'static' } },
      { key: 'notes', label: 'Notes', type: 'text', definition: { type: 'static' } },
    ];
  }
  return [];
}
