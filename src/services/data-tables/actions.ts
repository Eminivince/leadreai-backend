import mongoose from 'mongoose';
import DataTable from '../../models/DataTable.js';
import DataSourceCredential from '../../models/DataSourceCredential.js';
import { getDataSource } from '../data-sources/registry.js';
import { dispatchEnrichment } from './enrichment.js';
import {
  ACTIONS,
  getAction as lookupAction,
  type DataSourceAction,
  type ColumnDef,
  type RowType,
} from '../../../shared/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';

/**
 * Actions service — wraps the catalog with workspace-aware availability
 * checks and the one-shot "configure + run" entry point.
 */

export interface ActionAvailability {
  action: DataSourceAction;
  available: boolean;
  /** When not available — human-readable cause. The most common case is
   *  missing credentials on a BYOK source, with an inline "connect X" CTA. */
  unavailableReason?: 'missing_credentials' | 'source_not_registered';
  requiresCredentialForSourceId?: string;
}

/**
 * Returns every action in the catalog, annotated with whether this
 * workspace can currently run it. Used by the frontend action modal to
 * show the full list (locked + unlocked) so users see what's possible
 * alongside one-click "Connect <source>" links for gated actions.
 */
export async function listActionsForWorkspace(params: {
  workspaceId: string;
  rowType?: RowType;
}): Promise<ActionAvailability[]> {
  const { workspaceId, rowType } = params;

  const pool = rowType
    ? ACTIONS.filter((a) => a.rowTypes.includes(rowType))
    : ACTIONS;

  // One DB round trip — every credential for this workspace, regardless of source.
  // Cardinality is small (workspaces rarely have 50+ creds).
  const creds = await DataSourceCredential
    .find({ workspaceId: new mongoose.Types.ObjectId(workspaceId) })
    .select('dataSourceId')
    .lean();
  const credSourceIds = new Set(creds.map((c) => c.dataSourceId));

  return pool.map((action) => {
    const ds = getDataSource(action.sourceId);
    if (!ds) {
      return {
        action,
        available: false,
        unavailableReason: 'source_not_registered',
      };
    }

    // Sources with auth type 'none' or 'platform' don't need workspace creds.
    const needsCred = ds.auth.type !== 'none' && ds.auth.type !== 'platform';
    if (needsCred && !credSourceIds.has(action.sourceId)) {
      return {
        action,
        available: false,
        unavailableReason: 'missing_credentials',
        requiresCredentialForSourceId: action.sourceId,
      };
    }

    return { action, available: true };
  });
}

/**
 * Payload the /run endpoint accepts. `inputMappings` lets the frontend
 * override the auto-detected defaults; the backend re-validates that
 * every required input is resolvable before committing.
 */
export interface RunActionInput {
  // inputMappings[sourceInputKey] = { kind: 'column'; key } | { kind: 'literal'; value } | { kind: 'row_type_id' }
  inputMappings: Record<
    string,
    { kind: 'column'; key: string } | { kind: 'literal'; value: string } | { kind: 'row_type_id' }
  >;
  /** Column to write the action's output into. If the key doesn't exist
   *  on the table, it's created. If it exists as a `static` column, it's
   *  reconfigured as `enriched` (the existing cell values are preserved
   *  until enrichment overwrites them). */
  outputColumn: {
    key: string;
    label?: string;            // defaults to action.output.defaultLabel
  };
  /** Skip rows where the output column already has a value. Default true. */
  skipExisting?: boolean;
  /** Restrict to these rows. Omit for "all rows in the table." */
  rowIds?: string[];
}

export interface RunActionResult {
  actionId: string;
  columnKey: string;
  enrichmentRunId: string;
  jobsEnqueued: number;
}

/**
 * Configure + dispatch in one call. Equivalent to:
 *   1. POST /columns or PATCH /columns (create-or-update column
 *      with definition = enriched + action's inputMappings + outputPath)
 *   2. POST /columns/:key/run (enqueue enrichment)
 *
 * Exposing this as one endpoint keeps the frontend action modal atomic:
 * either the whole run fires, or nothing changes.
 */
export async function runAction(params: {
  workspaceId: string;
  tableId: string;
  actionId: string;
  input: RunActionInput;
}): Promise<RunActionResult> {
  const { workspaceId, tableId, actionId, input } = params;

  const action = lookupAction(actionId);
  if (!action) throw ApiError.notFound(`Action not found: ${actionId}`);

  const ds = getDataSource(action.sourceId);
  if (!ds) throw ApiError.badRequest(`Backing data source missing: ${action.sourceId}`);

  const table = await DataTable.findOne({ _id: tableId, workspaceId });
  if (!table) throw ApiError.notFound('Table not found');

  // Action applicability — reject early if this action wasn't built for
  // this rowType. Prevents e.g. "Verify emails" on a URL-typed table
  // where the heuristic would misfire.
  if (!action.rowTypes.includes(table.rowType as RowType)) {
    throw ApiError.badRequest(
      `Action "${action.label}" is not applicable to "${table.rowType}"-type tables`,
    );
  }

  // Credential gate — identical to what listActionsForWorkspace surfaces,
  // re-checked here so a stale UI can't submit a run for a source we just
  // disconnected.
  const needsCred = ds.auth.type !== 'none' && ds.auth.type !== 'platform';
  if (needsCred) {
    const cred = await DataSourceCredential.findOne({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      dataSourceId: action.sourceId,
    }).select('_id').lean();
    if (!cred) {
      throw ApiError.badRequest(
        `This action requires a ${action.sourceDisplayName} credential. Add one in Settings → Data sources.`,
      );
    }
  }

  // Validate that every required input is mapped.
  for (const spec of action.inputs) {
    if (spec.required && !input.inputMappings[spec.sourceInputKey]) {
      throw ApiError.badRequest(`Required input "${spec.label}" is not mapped`);
    }
  }

  // Upsert the output column. If it already exists, we replace its
  // definition (turning static → enriched). If not, we append it.
  const outColKey = input.outputColumn.key;
  const outColLabel = input.outputColumn.label ?? action.output.defaultLabel;
  const newColumnDef: ColumnDef = {
    key: outColKey,
    label: outColLabel,
    type: action.output.type,
    definition: {
      type: 'enriched',
      sourceId: action.sourceId,
      inputMappings: input.inputMappings,
      outputPath: action.output.outputPath,
    },
  };

  const existingIdx = table.columns.findIndex((c) => c.key === outColKey);
  if (existingIdx === -1) {
    table.columns.push(newColumnDef);
  } else {
    table.columns[existingIdx] = newColumnDef;
  }
  await table.save();

  logger.info('[actions] column upserted', {
    workspaceId, tableId, actionId, columnKey: outColKey,
    replaced: existingIdx !== -1,
  });

  // Dispatch the enrichment. Same worker, same invocation log,
  // same cost tracking as the power-user Connect path.
  const dispatch = await dispatchEnrichment({
    workspaceId,
    tableId,
    columnKey: outColKey,
    skipExisting: input.skipExisting ?? true,
    ...(Array.isArray(input.rowIds) ? { rowIds: input.rowIds } : {}),
  });

  return {
    actionId,
    columnKey: outColKey,
    enrichmentRunId: dispatch.enrichmentRunId,
    jobsEnqueued: dispatch.jobsEnqueued,
  };
}
