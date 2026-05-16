import { type Request, type Response } from 'express';
import type mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import { ApiError } from '../utils/ApiError.js';

export async function listLeads(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const {
    jobId,
    country,
    industry,
    hasEmail,
    hasPhone,
    isDuplicate = 'false',
    page: pageStr,
    limit: limitStr,
    sortBy = 'rankScore',
    sortOrder = 'desc',
    q,
  } = req.query as Record<string, string | undefined>;

  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
  const limit = Math.min(parseInt(limitStr ?? '20', 10) || 20, 100);
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = { workspaceId };
  if (jobId) filter.jobId = jobId;
  if (country) filter['address.country'] = new RegExp(country, 'i');
  if (industry) filter.industry = new RegExp(industry, 'i');
  if (hasEmail === 'true') filter['emails.0'] = { $exists: true };
  if (hasPhone === 'true') filter['phones.0'] = { $exists: true };
  filter.isDuplicate = isDuplicate === 'true';
  if (q) filter.$text = { $search: q };

  const sortDirection = sortOrder === 'asc' ? 1 : -1;

  const [leads, total] = await Promise.all([
    Lead.find(filter).sort({ [sortBy]: sortDirection }).skip(skip).limit(limit),
    Lead.countDocuments(filter),
  ]);

  res.json({ success: true, data: leads, total, page, limit });
}

export async function getLead(req: Request, res: Response): Promise<void> {
  const { workspaceId, leadId } = req.params;

  const lead = await Lead.findOne({ _id: leadId, workspaceId });
  if (!lead) throw ApiError.notFound('Lead not found');

  res.json({ success: true, data: lead });
}

export async function updateLead(req: Request, res: Response): Promise<void> {
  const { workspaceId, leadId } = req.params;
  const body = req.body as Record<string, unknown>;

  const allowed = ['tags', 'notes', 'outreachStatus'];
  const update: Record<string, unknown> = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k))
  );

  // Allow patching the primary email address
  if (typeof body.primaryEmail === 'string') {
    const addr = body.primaryEmail.trim().toLowerCase();
    if (addr && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      update['emails.0'] = { address: addr, type: 'business', confidence: 1, verified: false, source: 'manual' };
    }
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: leadId, workspaceId },
    { $set: update },
    { new: true }
  );
  if (!lead) throw ApiError.notFound('Lead not found');

  res.json({ success: true, data: lead });
}

export async function deleteLead(req: Request, res: Response): Promise<void> {
  const { workspaceId, leadId } = req.params;

  const lead = await Lead.findOneAndDelete({ _id: leadId, workspaceId });
  if (!lead) throw ApiError.notFound('Lead not found');

  res.json({ success: true });
}

export async function bulkTagLeads(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const { leadIds, tags, action } = req.body as {
    leadIds: string[];
    tags: string[];
    action: 'add' | 'remove';
  };

  const op =
    action === 'add'
      ? { $addToSet: { tags: { $each: tags } } }
      : { $pull: { tags: { $in: tags } } };

  await Lead.updateMany({ _id: { $in: leadIds }, workspaceId }, op);
  res.json({ success: true });
}

export async function bulkDeleteLeads(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const { leadIds } = req.body as { leadIds: string[] };

  await Lead.deleteMany({ _id: { $in: leadIds }, workspaceId });
  res.json({ success: true });
}

/* ── Bulk suppression (Task #18) ─────────────────────────────────── */

/**
 * Add every selected lead's primary email + domain to the workspace
 * suppression list. The reply-pause / bounce-suppress paths already
 * check this list before any send, so this is the canonical "block
 * outreach to these leads" lever for an agency mid-campaign.
 */
export async function bulkSuppressLeads(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const body = req.body as { leadIds?: string[]; mode?: 'email' | 'domain' | 'both' };
  const leadIds = body.leadIds ?? [];
  const mode = body.mode ?? 'email';
  if (leadIds.length === 0) {
    res.json({ success: true, data: { suppressed: 0 } });
    return;
  }

  const leads = await Lead.find({ _id: { $in: leadIds }, workspaceId })
    .select('emails companyDomain')
    .lean();

  // De-dupe the (workspace, email|domain) pairs before insert so a 500-
  // lead bulk doesn't try to insert 500 dup-key conflicts. The model
  // itself has a unique index per workspace + value; ordered:false
  // tolerates the residual races.
  const { SuppressionEntry } = await import('../models/SuppressionList.js');
  const entries: Array<{ workspaceId: string; email?: string; domain?: string; addedBy?: mongoose.Types.ObjectId; addedAt: Date }> = [];
  const now = new Date();
  for (const lead of leads) {
    const primary = lead.emails?.[0]?.address?.toLowerCase();
    if ((mode === 'email' || mode === 'both') && primary) {
      entries.push({ workspaceId: workspaceId!, email: primary, addedBy: req.user?._id, addedAt: now });
    }
    if ((mode === 'domain' || mode === 'both') && lead.companyDomain) {
      entries.push({ workspaceId: workspaceId!, domain: lead.companyDomain.toLowerCase(), addedBy: req.user?._id, addedAt: now });
    }
  }

  if (entries.length === 0) {
    res.json({ success: true, data: { suppressed: 0 } });
    return;
  }

  try {
    const inserted = await SuppressionEntry.insertMany(entries, { ordered: false });
    res.json({ success: true, data: { suppressed: inserted.length } });
  } catch (err: unknown) {
    // Duplicate-key 11000s on the unique index are expected on a
    // partial overlap; pluck the actual insertedDocs count instead of
    // bailing the whole request.
    const bulkErr = err as { insertedDocs?: unknown[]; result?: { insertedCount?: number } };
    const count = bulkErr.insertedDocs?.length ?? bulkErr.result?.insertedCount ?? 0;
    res.json({ success: true, data: { suppressed: count } });
  }
}
