import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { SuppressionEntry } from '../models/SuppressionList.js';
import { ApiError } from '../utils/ApiError.js';

const VALID_REASONS = ['unsubscribe', 'bounce', 'manual', 'competitor'] as const;
type SuppressionReason = (typeof VALID_REASONS)[number];

export async function listSuppression(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50));

  const [entries, total] = await Promise.all([
    SuppressionEntry.find({ workspaceId }).sort({ addedAt: -1 }).skip((page - 1) * limit).limit(limit),
    SuppressionEntry.countDocuments({ workspaceId }),
  ]);
  res.json({ success: true, data: { data: entries, total, page, limit } });
}

export async function addSuppression(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;
  const { email, domain, reason } = req.body as { email?: string; domain?: string; reason?: string };

  if (!email && !domain) throw ApiError.badRequest('email or domain is required');
  if (!reason || !VALID_REASONS.includes(reason as SuppressionReason)) {
    throw ApiError.badRequest(`reason must be one of: ${VALID_REASONS.join(', ')}`);
  }

  const existing = await SuppressionEntry.findOne({
    workspaceId,
    ...(email ? { email: email.toLowerCase().trim() } : { domain: domain!.toLowerCase().trim() }),
  });
  if (existing) {
    res.status(200).json({ success: true, data: existing });
    return;
  }

  const entry = await SuppressionEntry.create({
    workspaceId,
    email: email ? email.toLowerCase().trim() : undefined,
    domain: domain ? domain.toLowerCase().trim() : undefined,
    reason,
    addedAt: new Date(),
    addedBy: req.user._id,
  });
  res.status(201).json({ success: true, data: entry });
}

export async function removeSuppression(req: Request, res: Response): Promise<void> {
  const { workspaceId, suppressionId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(suppressionId!)) throw ApiError.badRequest('Invalid suppressionId');

  const result = await SuppressionEntry.deleteOne({ _id: suppressionId, workspaceId });
  if (result.deletedCount === 0) throw ApiError.notFound('Suppression entry not found');
  res.json({ success: true });
}

export async function checkSuppression(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const { email } = req.body as { email?: string };
  if (!email || typeof email !== 'string') throw ApiError.badRequest('email is required');

  const normalizedEmail = email.toLowerCase().trim();
  const domain = normalizedEmail.split('@')[1] ?? '';

  const entry = await SuppressionEntry.findOne({
    workspaceId,
    $or: [{ email: normalizedEmail }, { domain }],
  });

  res.json({
    success: true,
    data: {
      suppressed: !!entry,
      reason: entry?.reason ?? null,
    },
  });
}
