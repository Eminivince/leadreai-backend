import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { summarize, getDataSource, toSummary } from '../services/data-sources/registry.js';
import {
  createCredential,
  testCredential,
} from '../services/data-sources/credentials.js';
import { runDataSource } from '../services/data-sources/executor.js';
import DataSourceCredential from '../models/DataSourceCredential.js';
import DataSourceInvocation from '../models/DataSourceInvocation.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from '../services/audit.js';
import { CreateCredentialInputSchema } from '../../shared/index.js';

// ── Registry listing ────────────────────────────────────────────────

export async function listSources(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: summarize() });
}

export async function getSource(req: Request, res: Response): Promise<void> {
  const { dataSourceId } = req.params;
  const ds = getDataSource(dataSourceId!);
  if (!ds) throw ApiError.notFound('Data source not found');
  res.json({ success: true, data: toSummary(ds) });
}

// ── Credentials ─────────────────────────────────────────────────────

export async function listCredentials(req: Request, res: Response): Promise<void> {
  const { workspaceId, dataSourceId } = req.params;
  const creds = await DataSourceCredential
    .find({ workspaceId: new mongoose.Types.ObjectId(workspaceId!), dataSourceId })
    .sort({ isDefault: -1, createdAt: -1 });
  res.json({ success: true, data: creds });
}

export async function addCredential(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, dataSourceId } = req.params;

  const parsed = CreateCredentialInputSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
  }

  const cred = await createCredential({
    workspaceId: workspaceId!,
    dataSourceId: dataSourceId!,
    fields: parsed.data.fields,
    label: parsed.data.label,
    isDefault: parsed.data.isDefault,
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'data_source.credential.create',
    resourceType: 'campaign',      // reuse closest existing enum; expand later
    resourceId: cred._id,
    metadata: { dataSourceId, label: cred.label ?? null, isDefault: cred.isDefault },
  });

  res.status(201).json({
    success: true,
    data: {
      _id: cred._id,
      workspaceId: cred.workspaceId,
      dataSourceId: cred.dataSourceId,
      label: cred.label,
      isDefault: cred.isDefault,
      createdAt: cred.createdAt,
    },
  });
}

export async function deleteCredential(req: Request, res: Response): Promise<void> {
  const { workspaceId, dataSourceId, credentialId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(credentialId!)) {
    throw ApiError.badRequest('Invalid credentialId');
  }
  const cred = await DataSourceCredential.findOneAndDelete({
    _id: credentialId,
    workspaceId,
    dataSourceId,
  });
  if (!cred) throw ApiError.notFound('Credential not found');

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'data_source.credential.delete',
    resourceType: 'campaign',
    resourceId: cred._id,
    metadata: { dataSourceId },
  });

  res.json({ success: true });
}

// Test a NEW credential before saving it. Body: { fields: {...} }. Does
// not persist — call addCredential after a successful test.
export async function testNewCredential(req: Request, res: Response): Promise<void> {
  const { dataSourceId } = req.params;
  const schema = z.object({ fields: z.record(z.string(), z.string().max(4000)) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest('Body must be { fields: { ... } }');

  const result = await testCredential(dataSourceId!, parsed.data.fields);
  res.json({ success: true, data: result });
}

// ── Invocations (log) ───────────────────────────────────────────────

export async function listInvocations(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50));
  const dataSourceId = req.query['dataSourceId'] as string | undefined;
  const status = req.query['status'] as string | undefined;
  const jobId = req.query['jobId'] as string | undefined;

  const filter: Record<string, unknown> = { workspaceId: new mongoose.Types.ObjectId(workspaceId!) };
  if (dataSourceId) filter['dataSourceId'] = dataSourceId;
  if (status) filter['status'] = status;
  if (jobId && mongoose.Types.ObjectId.isValid(jobId)) {
    filter['parentJobId'] = new mongoose.Types.ObjectId(jobId);
  }

  const [rows, total] = await Promise.all([
    DataSourceInvocation
      .find(filter)
      .sort({ occurredAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    DataSourceInvocation.countDocuments(filter),
  ]);

  res.json({ success: true, data: { data: rows, total, page, limit } });
}

export async function getInvocation(req: Request, res: Response): Promise<void> {
  const { workspaceId, invocationId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(invocationId!)) {
    throw ApiError.badRequest('Invalid invocationId');
  }
  const inv = await DataSourceInvocation.findOne({
    _id: invocationId,
    workspaceId: new mongoose.Types.ObjectId(workspaceId!),
  });
  if (!inv) throw ApiError.notFound('Invocation not found');
  res.json({ success: true, data: inv });
}

// ── Manual invocation ───────────────────────────────────────────────
//
// POST /workspaces/:w/data-sources/:id/invoke — run a source directly.
// This is the endpoint the UI's "Test run" + per-row/per-column enrichment
// (15C/15D) will lean on. Body: { input: {...}, credentialId?: string }.
//
export async function invokeSource(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, dataSourceId } = req.params;

  const schema = z.object({
    input: z.record(z.string(), z.unknown()),
    credentialId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest('Body must be { input: {...}, credentialId?: string }');

  const result = await runDataSource(dataSourceId!, parsed.data.input, {
    workspaceId: workspaceId!,
    triggeredBy: 'manual',
    ...(parsed.data.credentialId ? { credentialId: parsed.data.credentialId } : {}),
  });

  // Map invocation status → HTTP status for easier clients.
  const httpStatus =
    result.status === 'success' ? 200 :
    result.status === 'rate_limited' ? 429 :
    result.status === 'auth_failed' ? 401 :
    result.status === 'invalid_input' ? 400 :
    500;

  res.status(httpStatus).json({ success: result.status === 'success', data: result });
}
