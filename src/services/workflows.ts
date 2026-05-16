import mongoose from 'mongoose';
import DataTable from '../models/DataTable.js';
import ProspectingJob from '../models/ProspectingJob.js';
import Workflow, { type IWorkflowDoc } from '../models/Workflow.js';
import { dispatchProspectingJob } from './queue/jobDispatcher.js';
import { parseQuery } from './ai/queryParser.js';
import { checkQueryPolicy } from './ai/queryGuardrail.js';
import { chargeCredits, grantCredits } from './credits.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import type { WorkflowSeedParam } from '../../shared/index.js';

/**
 * Workflow runtime — the bit that turns a stored `Workflow` into a live
 * `DataTable` and (optionally) a prospecting job.
 *
 * We don't build a new job pipeline; we route through the same
 * `dispatchProspectingJob` the `/jobs` POST uses. Same guardrail, same
 * credit charge, same refund on failure — one code path, fewer bugs.
 *
 * The table is created with `sourceJobId` set pre-emptively so the
 * worker's `autoSeedTablesFromJob` step can populate rows as soon as
 * the dispatch completes. (v1 auto-seed is rowType='company' only, which
 * matches what our agent produces.)
 */

// ── Param interpolation ─────────────────────────────────────────────

/**
 * Interpolate `{{placeholders}}` in a template against a param record.
 * Throws on unknown params or missing required values. Keeps the rules
 * tight so workflow runs can't silently produce nonsense queries.
 */
export function interpolateTemplate(
  template: string,
  paramDefs: WorkflowSeedParam[],
  values: Record<string, string | number> | undefined,
): string {
  const vals = values ?? {};

  // Required-param gate — before touching the template.
  for (const p of paramDefs) {
    if (p.required && (vals[p.key] === undefined || vals[p.key] === '')) {
      if (p.defaultValue === undefined) {
        throw ApiError.badRequest(`Missing required parameter: ${p.label} (${p.key})`);
      }
    }
  }

  // Unknown params — caller passed a key not defined on the workflow.
  const known = new Set(paramDefs.map((p) => p.key));
  for (const key of Object.keys(vals)) {
    if (!known.has(key)) {
      throw ApiError.badRequest(`Unknown parameter: ${key}`);
    }
  }

  return template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_, rawKey: string) => {
    const key = rawKey.toLowerCase();
    const def = paramDefs.find((p) => p.key === key);
    const provided = vals[key];
    const val = provided !== undefined && provided !== '' ? provided : def?.defaultValue;
    if (val === undefined) {
      throw ApiError.badRequest(`Unresolved placeholder: {{${key}}} — no value and no default`);
    }
    return String(val);
  });
}

// ── Run ──────────────────────────────────────────────────────────────

interface RunWorkflowArgs {
  workflow: IWorkflowDoc;
  workspaceId: string;
  userId: string;
  input: {
    tableName: string;
    tableDescription?: string;
    tags?: string[];
    seedParams?: Record<string, string | number>;
    dispatchSeedJob: boolean;
  };
  reqForAudit: unknown;  // opaque — audit log plumbing
}

/**
 * Execute a workflow run. Creates a DataTable, optionally dispatches a
 * prospecting job, returns both IDs.
 *
 * Order of operations:
 *   1. Interpolate seed template (if seed + dispatchSeedJob) — fail fast
 *      on bad params before creating any state.
 *   2. Run policy guardrail on the interpolated query.
 *   3. Charge credits for the dispatch (if any).
 *   4. Create the table.
 *   5. Create + dispatch the job, pointing it at the table via
 *      `sourceJobId` / `sourceTableId` links.
 *   6. On dispatch failure: refund credits + delete the table.
 *
 * The table is considered the primary output — even if the job fails,
 * the user gets the table with its columns ready to populate manually.
 */
export async function runWorkflow(args: RunWorkflowArgs): Promise<{ tableId: string; jobId?: string }> {
  const { workflow, workspaceId, userId, input } = args;

  const willDispatch = input.dispatchSeedJob && Boolean(workflow.seed);

  // Auto-seeding only works for company-type tables in v1 — that's the
  // shape the prospecting agent produces. Person/url/custom tables can
  // still be created, but can't be seeded via agent.
  if (willDispatch && workflow.tableTemplate.rowType !== 'company') {
    throw ApiError.badRequest(
      `dispatchSeedJob requires rowType='company' — this workflow is '${workflow.tableTemplate.rowType}'`,
    );
  }

  // 1. Interpolate seed first so bad params error before we create state.
  let rawQuery: string | null = null;
  if (willDispatch && workflow.seed) {
    rawQuery = interpolateTemplate(
      workflow.seed.rawQueryTemplate,
      workflow.seed.parameters,
      input.seedParams,
    ).trim();
    if (rawQuery.length < 3) {
      throw ApiError.badRequest('Interpolated rawQuery is empty');
    }
  }

  // 2. Guardrail (same as /jobs POST). Free under the cost budget.
  if (rawQuery) {
    const policy = await checkQueryPolicy(rawQuery);
    if (policy.decision === 'refuse') {
      throw new ApiError(
        400,
        'POLICY_REFUSED',
        policy.reason ??
          'The seed query falls outside platform policy. Edit the workflow seed or run the workflow without dispatching a job.',
      );
    }
  }

  // 3. Credits. Charge now; refund on dispatch failure.
  const credits = rawQuery && env.CREDITS_PER_JOB > 0 ? env.CREDITS_PER_JOB : 0;
  if (credits > 0) {
    await chargeCredits({
      userId,
      workspaceId,
      amount: credits,
      reason: 'dispatch',
      description: `Workflow: ${workflow.name} — "${rawQuery!.slice(0, 60)}${rawQuery!.length > 60 ? '…' : ''}"`,
    });
  }

  // 4. Table first. sourceJobId stays empty for now — we'll backfill
  //    after the job is created (needs the ObjectId).
  const table = await DataTable.create({
    workspaceId,
    createdBy: userId,
    name: input.tableName,
    description: input.tableDescription,
    rowType: workflow.tableTemplate.rowType,
    columns: workflow.tableTemplate.columns,
    tags: input.tags ?? [],
  });

  // 5. Job, if asked. On any failure here: refund credits, delete the
  //    table we just made, rethrow. We'd rather ship no state than
  //    orphaned state.
  let jobId: string | undefined;
  if (rawQuery) {
    try {
      const parsedIntent = await parseQuery(rawQuery);
      const job = await ProspectingJob.create({
        workspaceId,
        createdBy: userId,
        rawQuery,
        parsedIntent,
        status: 'queued',
        creditsCharged: credits,
        // Downstream: the worker's auto-seed step finds tables with
        // sourceJobId === job._id and rowCount === 0 and projects leads
        // into them. Linking both ways keeps audits straightforward.
        sourceWorkflowId: workflow._id,
      });
      jobId = job._id.toString();

      // Link the table → job so the detail page can render a "seeding
      // from dispatch…" banner, and the auto-seed pass at job-complete
      // can find this table cheaply.
      table.sourceJobId = job._id;
      await table.save();

      const bullmqJob = await dispatchProspectingJob(jobId, workspaceId);
      job.bullmqJobId = bullmqJob.id ?? undefined;
      await job.save();
    } catch (err) {
      // Clean up — table + any created job row. Credit refund goes to the
      // top-up bucket (same reasoning as jobs.controller.ts).
      if (credits > 0) {
        await grantCredits({
          userId,
          workspaceId,
          amount: credits,
          bucket: 'topup',
          reason: 'dispatch.refund',
          description: 'Refund — workflow dispatch failed',
          metadata: { workflowId: String(workflow._id) },
        }).catch(() => {});
      }
      await DataTable.deleteOne({ _id: table._id }).catch(() => {});
      if (jobId) {
        await ProspectingJob.deleteOne({ _id: jobId }).catch(() => {});
      }
      throw err;
    }
  }

  // 6. Bookkeeping.
  await Workflow.updateOne(
    { _id: workflow._id },
    { $inc: { 'stats.timesRun': 1 }, $set: { 'stats.lastRunAt': new Date() } },
  );

  return { tableId: table._id.toString(), ...(jobId ? { jobId } : {}) };
}

// ── Snapshot a table into a workflow ────────────────────────────────

interface FromTableArgs {
  workspaceId: string;
  userId: string;
  tableId: string;
  name: string;
  description?: string;
  tags?: string[];
  includeSeed: boolean;
  defaultTableNameTemplate?: string;
}

export async function createWorkflowFromTable(args: FromTableArgs): Promise<IWorkflowDoc> {
  const { workspaceId, tableId, includeSeed } = args;
  if (!mongoose.Types.ObjectId.isValid(tableId)) throw ApiError.badRequest('Invalid tableId');

  const table = await DataTable.findOne({ _id: tableId, workspaceId });
  if (!table) throw ApiError.notFound('Table not found');

  // If the caller asked for a seed and the table traces back to a job,
  // capture that job's rawQuery as a parameter-less template. Users edit
  // it afterwards to add {{placeholders}}.
  let seed: { rawQueryTemplate: string; parameters: [] } | undefined;
  if (includeSeed && table.sourceJobId) {
    const job = await ProspectingJob.findById(table.sourceJobId, { rawQuery: 1 }).lean();
    if (job?.rawQuery) {
      seed = { rawQueryTemplate: job.rawQuery, parameters: [] };
    }
  }

  const workflow = await Workflow.create({
    workspaceId,
    createdBy: args.userId,
    name: args.name,
    description: args.description,
    tags: args.tags ?? [],
    tableTemplate: {
      rowType: table.rowType,
      columns: table.columns,
      ...(args.defaultTableNameTemplate ? { defaultTableNameTemplate: args.defaultTableNameTemplate } : {}),
    },
    ...(seed ? { seed } : {}),
    origin: 'local',
  });

  return workflow;
}
