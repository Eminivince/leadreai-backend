import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import File from '../models/File.js';
import Lead from '../models/Lead.js';
import Campaign from '../models/Campaign.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from '../services/audit.js';

function isOid(v: unknown): v is string {
  return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
}

function coerceOidArray(ids: unknown, field: string): mongoose.Types.ObjectId[] {
  if (!Array.isArray(ids)) throw ApiError.badRequest(`${field} must be an array`);
  const out: mongoose.Types.ObjectId[] = [];
  for (const id of ids) {
    if (!isOid(id)) throw ApiError.badRequest(`Invalid id in ${field}: ${String(id)}`);
    out.push(new mongoose.Types.ObjectId(id));
  }
  return out;
}

/**
 * GET /workspaces/:workspaceId/files
 *
 * Returns summary shape (lead count, not full leadIds) for list views.
 * `archived=true` includes archived files. Default filters them out.
 */
export async function listFiles(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50));
  const includeArchived = String(req.query['archived'] ?? '') === 'true';

  const filter: Record<string, unknown> = { workspaceId };
  if (!includeArchived) filter['archivedAt'] = { $exists: false };

  const [rows, total] = await Promise.all([
    File.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    File.countDocuments(filter),
  ]);

  const summaries = rows.map((f) => ({
    _id: String(f._id),
    name: f.name,
    description: f.description,
    source: f.source,
    sourceJobId: f.sourceJobId ? String(f.sourceJobId) : undefined,
    color: f.color,
    leadCount: Array.isArray(f.leadIds) ? f.leadIds.length : 0,
    archivedAt: f.archivedAt ? f.archivedAt.toISOString() : undefined,
    createdAt: f.createdAt?.toISOString?.() ?? String(f.createdAt),
    updatedAt: f.updatedAt?.toISOString?.() ?? String(f.updatedAt),
  }));

  res.json({ success: true, data: { data: summaries, total, page, limit } });
}

export async function getFile(req: Request, res: Response): Promise<void> {
  const { workspaceId, fileId } = req.params;
  if (!isOid(fileId)) throw ApiError.badRequest('Invalid fileId');

  const file = await File.findOne({ _id: fileId, workspaceId });
  if (!file) throw ApiError.notFound('File not found');

  res.json({ success: true, data: file });
}

export async function createFile(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;
  const body = req.body as {
    name?: unknown;
    description?: unknown;
    leadIds?: unknown;
    color?: unknown;
  };

  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw ApiError.badRequest('name is required');
  }
  if (body.name.trim().length > 200) {
    throw ApiError.badRequest('name must be 200 characters or fewer');
  }

  let leadOids: mongoose.Types.ObjectId[] = [];
  if (body.leadIds !== undefined) {
    leadOids = coerceOidArray(body.leadIds, 'leadIds');
    if (leadOids.length > 0) {
      const matching = await Lead.countDocuments({
        _id: { $in: leadOids },
        workspaceId: workspaceId!,
      });
      if (matching !== leadOids.length) {
        throw ApiError.badRequest('One or more leads do not belong to this workspace');
      }
    }
  }

  const file = await File.create({
    workspaceId: workspaceId!,
    createdBy: req.user._id,
    name: body.name.trim(),
    description: typeof body.description === 'string' ? body.description.trim() || undefined : undefined,
    color: typeof body.color === 'string' ? body.color.trim() || undefined : undefined,
    source: 'manual',
    leadIds: leadOids,
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'file.create',
    resourceType: 'file',
    resourceId: file._id,
    metadata: { name: file.name, leadCount: leadOids.length },
  });

  res.status(201).json({ success: true, data: file });
}

export async function updateFile(req: Request, res: Response): Promise<void> {
  const { workspaceId, fileId } = req.params;
  if (!isOid(fileId)) throw ApiError.badRequest('Invalid fileId');

  const body = req.body as {
    name?: unknown;
    description?: unknown;
    color?: unknown;
    archived?: unknown;
  };

  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw ApiError.badRequest('name must be a non-empty string');
    }
    if (body.name.trim().length > 200) {
      throw ApiError.badRequest('name must be 200 characters or fewer');
    }
    setFields['name'] = body.name.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') throw ApiError.badRequest('description must be a string');
    setFields['description'] = body.description.trim() || undefined;
  }
  if (body.color !== undefined) {
    if (typeof body.color !== 'string') throw ApiError.badRequest('color must be a string');
    setFields['color'] = body.color.trim() || undefined;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') throw ApiError.badRequest('archived must be boolean');
    if (body.archived) setFields['archivedAt'] = new Date();
    else unsetFields['archivedAt'] = '';
  }

  const updateOp: Record<string, unknown> = {};
  if (Object.keys(setFields).length) updateOp['$set'] = setFields;
  if (Object.keys(unsetFields).length) updateOp['$unset'] = unsetFields;

  if (Object.keys(updateOp).length === 0) {
    throw ApiError.badRequest('No valid fields to update');
  }

  const file = await File.findOneAndUpdate(
    { _id: fileId, workspaceId },
    updateOp,
    { new: true, runValidators: true },
  );
  if (!file) throw ApiError.notFound('File not found');

  res.json({ success: true, data: file });
}

export async function deleteFile(req: Request, res: Response): Promise<void> {
  const { workspaceId, fileId } = req.params;
  if (!isOid(fileId)) throw ApiError.badRequest('Invalid fileId');

  const file = await File.findOne({ _id: fileId, workspaceId });
  if (!file) throw ApiError.notFound('File not found');

  const campaignsTargeting = await Campaign.countDocuments({ workspaceId, fileId: file._id });
  if (campaignsTargeting > 0) {
    throw ApiError.badRequest(
      `Cannot delete — ${campaignsTargeting} campaign(s) target this file. Archive it or detach the campaigns first.`,
    );
  }

  await File.deleteOne({ _id: file._id });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'file.delete',
    resourceType: 'file',
    resourceId: file._id,
    metadata: { name: file.name },
  });

  res.json({ success: true });
}

export async function addLeadsToFile(req: Request, res: Response): Promise<void> {
  const { workspaceId, fileId } = req.params;
  if (!isOid(fileId)) throw ApiError.badRequest('Invalid fileId');

  const { leadIds } = req.body as { leadIds?: unknown };
  const oids = coerceOidArray(leadIds, 'leadIds');
  if (oids.length === 0) throw ApiError.badRequest('leadIds must be a non-empty array');
  if (oids.length > 500) throw ApiError.badRequest('Cannot add more than 500 leads per call');

  const matching = await Lead.countDocuments({ _id: { $in: oids }, workspaceId: workspaceId! });
  if (matching !== oids.length) {
    throw ApiError.badRequest('One or more leads do not belong to this workspace');
  }

  const file = await File.findOneAndUpdate(
    { _id: fileId, workspaceId },
    { $addToSet: { leadIds: { $each: oids } } },
    { new: true },
  );
  if (!file) throw ApiError.notFound('File not found');

  res.json({ success: true, data: file });
}

export async function removeLeadsFromFile(req: Request, res: Response): Promise<void> {
  const { workspaceId, fileId } = req.params;
  if (!isOid(fileId)) throw ApiError.badRequest('Invalid fileId');

  const { leadIds } = req.body as { leadIds?: unknown };
  const oids = coerceOidArray(leadIds, 'leadIds');
  if (oids.length === 0) throw ApiError.badRequest('leadIds must be a non-empty array');

  const file = await File.findOneAndUpdate(
    { _id: fileId, workspaceId },
    { $pull: { leadIds: { $in: oids } } },
    { new: true },
  );
  if (!file) throw ApiError.notFound('File not found');

  res.json({ success: true, data: file });
}

export async function listFileLeads(req: Request, res: Response): Promise<void> {
  const { workspaceId, fileId } = req.params;
  if (!isOid(fileId)) throw ApiError.badRequest('Invalid fileId');

  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50));

  const file = await File.findOne({ _id: fileId, workspaceId }).select('leadIds');
  if (!file) throw ApiError.notFound('File not found');

  if (file.leadIds.length === 0) {
    res.json({ success: true, data: { data: [], total: 0, page, limit } });
    return;
  }

  const leadFilter = { _id: { $in: file.leadIds }, workspaceId };
  const [leads, total] = await Promise.all([
    Lead.find(leadFilter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Lead.countDocuments(leadFilter),
  ]);

  res.json({ success: true, data: { data: leads, total, page, limit } });
}
