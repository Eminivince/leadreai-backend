import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import Workflow from '../models/Workflow.js';
import Workspace from '../models/Workspace.js';
import {
  CreateWorkflowSchema,
  CreateWorkflowFromTableSchema,
  UpdateWorkflowSchema,
  RunWorkflowSchema,
  InstallWorkflowSchema,
} from '../../shared/index.js';
import { createWorkflowFromTable, runWorkflow } from '../services/workflows.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from '../services/audit.js';
import { logger } from '../utils/logger.js';

/** 32-char URL-safe random token for the public install surface. We use
 *  hex instead of base64url so the token never carries chars (-, _) that
 *  some chat clients aggressively re-escape in shared URLs. */
function generateShareToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Workflow controller — Phase 11 M1.
 *
 * Endpoints mirror the spec in `docs/2026-04-22-phase-11-workflows-plan.md`.
 * Run semantics live in `services/workflows.ts::runWorkflow` so the
 * controller stays thin — the interesting logic (guardrail, credits,
 * rollback) is testable without HTTP.
 */

// ── List + get ──────────────────────────────────────────────────────

export async function listWorkflows(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50));

  const filter = { workspaceId: new mongoose.Types.ObjectId(workspaceId!) };
  const [workflows, total] = await Promise.all([
    Workflow.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit),
    Workflow.countDocuments(filter),
  ]);
  res.json({ success: true, data: { data: workflows, total, page, limit } });
}

export async function getWorkflow(req: Request, res: Response): Promise<void> {
  const { workspaceId, workflowId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workflowId!)) throw ApiError.badRequest('Invalid workflowId');
  const workflow = await Workflow.findOne({ _id: workflowId, workspaceId });
  if (!workflow) throw ApiError.notFound('Workflow not found');
  res.json({ success: true, data: workflow });
}

// ── Create ──────────────────────────────────────────────────────────

export async function createWorkflow(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;

  const parsed = CreateWorkflowSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
  }

  // Column-key uniqueness mirrors DataTable.createTable's rule.
  const keys = new Set<string>();
  for (const c of parsed.data.tableTemplate.columns) {
    if (keys.has(c.key)) throw ApiError.badRequest(`Duplicate column key: ${c.key}`);
    keys.add(c.key);
  }

  const workflow = await Workflow.create({
    workspaceId: workspaceId!,
    createdBy: req.user._id,
    name: parsed.data.name,
    description: parsed.data.description,
    tags: parsed.data.tags ?? [],
    tableTemplate: parsed.data.tableTemplate,
    ...(parsed.data.seed ? { seed: parsed.data.seed } : {}),
    origin: 'local',
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'workflow.create',
    resourceType: 'campaign',
    resourceId: workflow._id,
    metadata: { name: workflow.name, columnCount: parsed.data.tableTemplate.columns.length },
  });

  res.status(201).json({ success: true, data: workflow });
}

export async function createFromTable(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, tableId } = req.params;

  const parsed = CreateWorkflowFromTableSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
  }

  const workflow = await createWorkflowFromTable({
    workspaceId: workspaceId!,
    userId: String(req.user._id),
    tableId: tableId!,
    name: parsed.data.name,
    description: parsed.data.description,
    tags: parsed.data.tags,
    includeSeed: parsed.data.includeSeed,
    defaultTableNameTemplate: parsed.data.defaultTableNameTemplate,
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'workflow.create_from_table',
    resourceType: 'campaign',
    resourceId: workflow._id,
    metadata: { tableId, hasSeed: Boolean(workflow.seed) },
  });

  res.status(201).json({ success: true, data: workflow });
}

// ── Update + delete ─────────────────────────────────────────────────

export async function updateWorkflow(req: Request, res: Response): Promise<void> {
  const { workspaceId, workflowId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workflowId!)) throw ApiError.badRequest('Invalid workflowId');

  const parsed = UpdateWorkflowSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
  }

  const setOps: Record<string, unknown> = {};
  const unsetOps: Record<string, unknown> = {};

  if (parsed.data.name !== undefined) setOps['name'] = parsed.data.name;
  if (parsed.data.description !== undefined) setOps['description'] = parsed.data.description;
  if (parsed.data.tags !== undefined) setOps['tags'] = parsed.data.tags;
  if (parsed.data.tableTemplate !== undefined) setOps['tableTemplate'] = parsed.data.tableTemplate;
  // `seed: null` clears the seed entirely; `seed: {...}` replaces it.
  if (parsed.data.seed === null) unsetOps['seed'] = '';
  else if (parsed.data.seed !== undefined) setOps['seed'] = parsed.data.seed;

  const update: Record<string, unknown> = {};
  if (Object.keys(setOps).length > 0) update['$set'] = setOps;
  if (Object.keys(unsetOps).length > 0) update['$unset'] = unsetOps;

  if (Object.keys(update).length === 0) {
    throw ApiError.badRequest('No updatable fields provided');
  }

  const workflow = await Workflow.findOneAndUpdate(
    { _id: workflowId, workspaceId },
    update,
    { new: true },
  );
  if (!workflow) throw ApiError.notFound('Workflow not found');

  res.json({ success: true, data: workflow });
}

export async function deleteWorkflow(req: Request, res: Response): Promise<void> {
  const { workspaceId, workflowId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workflowId!)) throw ApiError.badRequest('Invalid workflowId');

  const result = await Workflow.deleteOne({ _id: workflowId, workspaceId });
  if (result.deletedCount === 0) throw ApiError.notFound('Workflow not found');

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'workflow.delete',
    resourceType: 'campaign',
    resourceId: workflowId!,
  });

  res.json({ success: true, data: { deleted: true } });
}

// ── Run ─────────────────────────────────────────────────────────────

export async function runWorkflowHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, workflowId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workflowId!)) throw ApiError.badRequest('Invalid workflowId');

  const parsed = RunWorkflowSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
  }

  const workflow = await Workflow.findOne({ _id: workflowId, workspaceId });
  if (!workflow) throw ApiError.notFound('Workflow not found');

  const result = await runWorkflow({
    workflow,
    workspaceId: workspaceId!,
    userId: String(req.user._id),
    input: parsed.data,
    reqForAudit: req,
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'workflow.run',
    resourceType: 'campaign',
    resourceId: workflow._id,
    metadata: {
      workflowName: workflow.name,
      tableId: result.tableId,
      jobId: result.jobId ?? null,
      dispatchedSeedJob: Boolean(result.jobId),
    },
  });

  res.status(201).json({ success: true, data: result });
}

// ── Publish / install (Phase 11 M2) ─────────────────────────────────

/**
 * Generate a shareToken + set publishedAt. Idempotent: republishing an
 * already-published workflow rotates the token (invalidating prior
 * install links), which is what an agency would expect after editing
 * a workflow they don't want widely-shared copies of anymore.
 */
export async function publishWorkflow(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, workflowId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workflowId!)) throw ApiError.badRequest('Invalid workflowId');

  const shareToken = generateShareToken();
  const workflow = await Workflow.findOneAndUpdate(
    { _id: workflowId, workspaceId },
    {
      $set: { shareToken, publishedAt: new Date() },
      $setOnInsert: { publishStats: { installs: 0 } },
    },
    { new: true, projection: { shareToken: 1, publishedAt: 1, publishStats: 1, name: 1 } },
  );
  if (!workflow) throw ApiError.notFound('Workflow not found');

  // Backfill publishStats if missing (older docs predate this field).
  if (!workflow.publishStats) {
    await Workflow.updateOne({ _id: workflowId }, { $set: { publishStats: { installs: 0 } } });
  }

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'workflow.publish',
    resourceType: 'campaign',
    resourceId: workflow._id,
    metadata: { workflowName: workflow.name, rotated: true },
  });

  res.json({
    success: true,
    data: {
      shareToken: workflow.shareToken,
      publishedAt: workflow.publishedAt,
      publishStats: workflow.publishStats ?? { installs: 0 },
    },
  });
}

/** Clear shareToken + publishedAt. The unique sparse index unsets cleanly. */
export async function unpublishWorkflow(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, workflowId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workflowId!)) throw ApiError.badRequest('Invalid workflowId');

  const workflow = await Workflow.findOneAndUpdate(
    { _id: workflowId, workspaceId },
    { $unset: { shareToken: 1, publishedAt: 1 } },
    { new: true },
  );
  if (!workflow) throw ApiError.notFound('Workflow not found');

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'workflow.unpublish',
    resourceType: 'campaign',
    resourceId: workflow._id,
  });

  res.json({ success: true, data: { unpublished: true } });
}

/**
 * Public preview of a published workflow. Redacts workspaceId + createdBy
 * so an unauth'd visitor can't enumerate who's running what. Used by the
 * `/install/:shareToken` landing page so the user can decide whether to
 * install before authenticating.
 */
export async function previewInstall(req: Request, res: Response): Promise<void> {
  const { shareToken } = req.params;
  if (!shareToken || shareToken.length !== 32) throw ApiError.badRequest('Invalid share token');

  const workflow = await Workflow.findOne({ shareToken })
    .select('name description tags tableTemplate seed publishedAt publishStats')
    .lean();
  if (!workflow) throw ApiError.notFound('No published workflow for that link');

  res.json({
    success: true,
    data: {
      name: workflow.name,
      description: workflow.description,
      tags: workflow.tags ?? [],
      tableTemplate: workflow.tableTemplate,
      hasSeed: Boolean(workflow.seed),
      seedParameters: workflow.seed?.parameters,
      publishedAt: workflow.publishedAt?.toISOString(),
      publishStats: workflow.publishStats ?? { installs: 0 },
    },
  });
}

/**
 * Install a published workflow into the caller's target workspace.
 *
 * Independent-copies semantics per goal.md §10.4 — the install creates
 * a brand-new Workflow doc with origin='installed' + installedFrom
 * pointer; later edits to the source workflow do NOT propagate
 * downstream. The pointer is purely provenance.
 */
export async function installWorkflow(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { shareToken } = req.params;
  if (!shareToken || shareToken.length !== 32) throw ApiError.badRequest('Invalid share token');

  const parsed = InstallWorkflowSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
  const { targetWorkspaceId, name } = parsed.data;

  if (!mongoose.Types.ObjectId.isValid(targetWorkspaceId)) {
    throw ApiError.badRequest('Invalid targetWorkspaceId');
  }

  // Membership check on the target workspace — we don't trust the
  // body alone. authorize() can't help here because the route is
  // outside the :workspaceId scope.
  const target = await Workspace.findById(targetWorkspaceId);
  if (!target) throw ApiError.notFound('Target workspace not found');
  const isMember =
    target.ownerId.toString() === String(req.user._id) ||
    target.members.some((m) => m.userId.toString() === String(req.user!._id));
  if (!isMember) throw ApiError.forbidden('Not a member of the target workspace');

  const source = await Workflow.findOne({ shareToken });
  if (!source) throw ApiError.notFound('No published workflow for that link');
  if (!source.publishedAt) throw ApiError.badRequest('Workflow is not currently published');

  // Build the new workflow. Stats reset to 0 in the new workspace —
  // installs are independent runtimes.
  const newWorkflow = await Workflow.create({
    workspaceId: targetWorkspaceId,
    createdBy: req.user._id,
    name: (name ?? source.name).slice(0, 200),
    description: source.description,
    tags: source.tags,
    tableTemplate: source.tableTemplate,
    seed: source.seed,
    origin: 'installed',
    stats: { timesRun: 0 },
    installedFrom: {
      shareToken,
      sourceWorkflowId: source._id,
      sourceWorkspaceId: source.workspaceId,
      publishedBy: source.createdBy,
      installedAt: new Date(),
    },
  });

  // Increment the source's install counter. Fire-and-forget — a stats
  // bump that races with concurrent installs is fine; the unique-share-
  // token lookup guarantees we credit the right source.
  await Workflow.updateOne(
    { _id: source._id },
    {
      $inc: { 'publishStats.installs': 1 },
      $set: { 'publishStats.lastInstalledAt': new Date() },
    },
  ).catch((err: unknown) => {
    logger.warn('[workflows] install counter bump failed', {
      sourceWorkflowId: String(source._id),
      err: err instanceof Error ? err.message : String(err),
    });
  });

  logAudit({
    req,
    workspaceId: targetWorkspaceId,
    action: 'workflow.install',
    resourceType: 'campaign',
    resourceId: newWorkflow._id,
    metadata: {
      shareToken,
      sourceWorkflowId: String(source._id),
      sourceWorkspaceId: String(source.workspaceId),
    },
  });

  res.status(201).json({ success: true, data: newWorkflow });
}
