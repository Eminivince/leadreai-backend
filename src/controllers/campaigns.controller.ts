import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Sequence from '../models/Sequence.js';
import SequenceEnrollment from '../models/SequenceEnrollment.js';
import OutreachDraft from '../models/OutreachDraft.js';
import Lead from '../models/Lead.js';
import File from '../models/File.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from '../services/audit.js';
import {
  buildSequenceFromPayload,
  computePreflight,
  activateCampaign,
  computeCampaignStats,
  pauseCampaign,
  resumeCampaign,
} from '../services/campaigns.js';
import { CreateCampaignSchema } from '../../shared/index.js';
import { logger } from '../utils/logger.js';

export async function listCampaigns(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10) || 20));
  const status = req.query['status'] as string | undefined;

  const VALID_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'];
  if (status && !VALID_STATUSES.includes(status)) {
    throw ApiError.badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const filter: Record<string, unknown> = { workspaceId };
  if (status) filter['status'] = status;

  const [campaigns, total] = await Promise.all([
    Campaign.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Campaign.countDocuments(filter),
  ]);

  res.json({ success: true, data: { data: campaigns, total, page, limit } });
}

export async function createCampaign(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;

  // Canonical payload — wizard converts its UI strings to typed shape before POST.
  const parsed = CreateCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    const path = first?.path.join('.');
    throw ApiError.badRequest(
      path ? `${path}: ${first?.message ?? 'invalid'}` : (first?.message ?? 'Invalid request body'),
    );
  }
  const payload = parsed.data;

  const file = await File.findOne({ _id: payload.fileId, workspaceId });
  if (!file) throw ApiError.badRequest('fileId does not reference a file in this workspace');

  // Create the Sequence first so the Campaign can reference it. If the
  // Campaign create fails after this, we attempt to clean up the orphan
  // Sequence — no transaction because the rest of the codebase doesn't
  // require a replica set.
  const sequenceInput = buildSequenceFromPayload({
    workspaceId: new mongoose.Types.ObjectId(workspaceId!),
    createdBy: new mongoose.Types.ObjectId(String(req.user._id)),
    payload,
  });

  const sequence = await Sequence.create({
    ...sequenceInput,
    name: `${payload.name} — sequence`,
  });

  let campaign;
  try {
    // First step's tone is the campaign-wide fallback for the legacy
    // `outreachConfig.tone` field still consumed by the bulk-draft worker
    // in outreach.worker.ts (predates per-step tone).
    const firstStep = payload.steps[0]!;
    campaign = await Campaign.create({
      workspaceId: workspaceId!,
      createdBy: req.user._id,
      name: payload.name,
      description: payload.description,
      status: 'draft',
      fileId: file._id,
      sequenceId: sequence._id,
      schedule: payload.schedule,
      audienceFilters: payload.audienceFilters,
      replyRules: payload.replyRules,
      outreachConfig: {
        channel: firstStep.channel,
        tone: firstStep.tone,
        language: payload.language,
        personalization: [],
      },
    });
  } catch (err) {
    // Best-effort cleanup so the orphan sequence doesn't pile up.
    await Sequence.deleteOne({ _id: sequence._id }).catch((cleanupErr) => {
      logger.error('campaign.create: orphan sequence cleanup failed', {
        sequenceId: String(sequence._id),
        workspaceId,
        err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    });
    throw err;
  }

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'campaign.create',
    resourceType: 'campaign',
    resourceId: campaign._id,
    metadata: {
      name: campaign.name,
      fileId: String(file._id),
      sequenceId: String(sequence._id),
      stepCount: payload.steps.length,
    },
  });

  res.status(201).json({ success: true, data: { campaign, sequence } });
}

export async function getCampaign(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');

  // Include the associated Sequence so the wizard can round-trip every
  // chapter's state from one fetch.
  const sequence = campaign.sequenceId
    ? await Sequence.findOne({ _id: campaign.sequenceId, workspaceId })
    : null;

  res.json({ success: true, data: { campaign, sequence } });
}

export async function updateCampaign(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }

  const body = req.body as {
    name?: string;
    description?: string;
    tone?: string;
    language?: string;
  };

  const setFields: Record<string, unknown> = {};

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
    setFields['description'] = body.description;
  }

  if (body.tone !== undefined) {
    if (typeof body.tone !== 'string' || !body.tone.trim()) {
      throw ApiError.badRequest('tone must be a non-empty string');
    }
    setFields['outreachConfig.tone'] = body.tone.trim();
  }

  if (body.language !== undefined) {
    if (typeof body.language !== 'string' || !body.language.trim()) {
      throw ApiError.badRequest('language must be a non-empty string');
    }
    setFields['outreachConfig.language'] = body.language.trim();
  }

  if (Object.keys(setFields).length === 0) {
    throw ApiError.badRequest('No valid fields to update');
  }

  const campaign = await Campaign.findOneAndUpdate(
    { _id: campaignId, workspaceId },
    { $set: setFields },
    { new: true, runValidators: true }
  );

  if (!campaign) throw ApiError.notFound('Campaign not found');

  res.json({ success: true, data: campaign });
}

export async function deleteCampaign(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');

  // Delete drafts first — orphaned drafts are unrecoverable if campaign is gone first
  await OutreachDraft.deleteMany({ campaignId: new mongoose.Types.ObjectId(campaignId!) });
  await Campaign.deleteOne({ _id: campaignId });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'campaign.delete',
    resourceType: 'campaign',
    resourceId: campaign._id,
    metadata: { name: campaign.name },
  });

  res.json({ success: true });
}

/**
 * Campaign leads are now derived from the campaign's File.
 * Mutation happens on the file (POST/DELETE /files/:fileId/leads),
 * not on the campaign. This endpoint just reads through.
 */
export async function listCampaignLeads(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }

  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10) || 20));

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId }).select('fileId');
  if (!campaign) throw ApiError.notFound('Campaign not found');

  const file = await File.findOne({ _id: campaign.fileId, workspaceId }).select('leadIds');
  if (!file || file.leadIds.length === 0) {
    res.json({ success: true, data: { data: [], total: 0, page, limit } });
    return;
  }

  const leadFilter = { _id: { $in: file.leadIds }, workspaceId };

  const [leads, total] = await Promise.all([
    Lead.find(leadFilter).skip((page - 1) * limit).limit(limit),
    Lead.countDocuments(leadFilter),
  ]);

  res.json({ success: true, data: { data: leads, total, page, limit } });
}

// ---------------------------------------------------------------------------
// preflightCampaign  GET /api/v1/workspaces/:workspaceId/campaigns/:campaignId/preflight
// ---------------------------------------------------------------------------

/**
 * Pure read. Returns what would happen if activation were invoked right
 * now — counts of enrollable/skipped leads, whether the workspace has an
 * email config, and the computed first-send time. The UI uses this to
 * show a summary before the user confirms activation.
 */
export async function preflightCampaign(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.sequenceId) {
    throw ApiError.badRequest('Campaign has no sequence — can only activate wizard-built campaigns');
  }

  const sequence = await Sequence.findOne({ _id: campaign.sequenceId, workspaceId });
  if (!sequence) throw ApiError.notFound('Associated sequence not found');

  const result = await computePreflight({
    workspaceId: new mongoose.Types.ObjectId(workspaceId!),
    campaign,
    sequence,
  });

  res.json({ success: true, data: result });
}

// ---------------------------------------------------------------------------
// activateCampaignHandler  POST /api/v1/workspaces/:workspaceId/campaigns/:campaignId/activate
// ---------------------------------------------------------------------------

/**
 * Flips the campaign + sequence to 'active' and bulk-creates enrollments
 * for every eligible lead in the file. Idempotent via the unique
 * (sequenceId, leadId) index. Blocks hard if the workspace has no email
 * config (pre-send would fail anyway), no eligible leads, or the sequence
 * has no steps.
 */
export async function activateCampaignHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, campaignId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.sequenceId) {
    throw ApiError.badRequest('Campaign has no sequence — can only activate wizard-built campaigns');
  }

  const sequence = await Sequence.findOne({ _id: campaign.sequenceId, workspaceId });
  if (!sequence) throw ApiError.notFound('Associated sequence not found');
  if (sequence.steps.length === 0) {
    throw ApiError.badRequest('Sequence has no steps');
  }

  const preflight = await computePreflight({
    workspaceId: new mongoose.Types.ObjectId(workspaceId!),
    campaign,
    sequence,
  });

  if (!preflight.hasEmailConfig) {
    throw ApiError.badRequest(
      'Workspace has no email configured. Visit Settings → Email before activating.',
    );
  }
  if (preflight.eligibleLeadsCount === 0 && preflight.skipped.alreadyEnrolled === 0) {
    throw ApiError.badRequest(
      `No enrollable leads. ${preflight.skipped.noEmail} have no email, ${preflight.skipped.suppressed} are suppressed, ${preflight.skipped.filtered} failed audience filters.`,
    );
  }

  const result = await activateCampaign({
    workspaceId: new mongoose.Types.ObjectId(workspaceId!),
    enrolledBy: new mongoose.Types.ObjectId(String(req.user._id)),
    campaign,
    sequence,
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'campaign.activate',
    resourceType: 'campaign',
    resourceId: campaign._id,
    metadata: {
      sequenceId: String(sequence._id),
      enrolled: result.enrolled,
      skipped: result.skipped,
    },
  });

  res.json({ success: true, data: { ...result, preflight } });
}

// ---------------------------------------------------------------------------
// campaignStats  GET /api/v1/workspaces/:workspaceId/campaigns/:campaignId/stats
// ---------------------------------------------------------------------------

export async function campaignStats(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.sequenceId) {
    // Legacy campaigns without a sequence — return a shape that still
    // renders on the detail page.
    res.json({
      success: true,
      data: {
        campaign,
        sequence: null,
        enrollments: { active: 0, paused: 0, completed: 0, stopped: 0, bounced: 0, unsubscribed: 0, replied: 0, total: 0 },
        perStep: [],
        campaignStats: campaign.stats,
        replyClassification: { positive: 0, ooo: 0, bounce: 0, unknown: 0 },
      },
    });
    return;
  }

  const sequence = await Sequence.findOne({ _id: campaign.sequenceId, workspaceId });
  if (!sequence) throw ApiError.notFound('Associated sequence not found');

  const stats = await computeCampaignStats({
    workspaceId: new mongoose.Types.ObjectId(workspaceId!),
    campaign,
    sequence,
  });

  res.json({ success: true, data: { campaign, sequence, ...stats } });
}

// ---------------------------------------------------------------------------
// pauseCampaignHandler  POST /api/v1/workspaces/:workspaceId/campaigns/:campaignId/pause
// ---------------------------------------------------------------------------

export async function pauseCampaignHandler(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }
  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.sequenceId) throw ApiError.badRequest('Campaign has no sequence');
  const sequence = await Sequence.findOne({ _id: campaign.sequenceId, workspaceId });
  if (!sequence) throw ApiError.notFound('Associated sequence not found');

  if (campaign.status !== 'active') {
    throw ApiError.conflict(`Campaign is ${campaign.status}, only active campaigns can be paused`);
  }

  const result = await pauseCampaign({
    workspaceId: new mongoose.Types.ObjectId(workspaceId!),
    campaign,
    sequence,
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'campaign.pause',
    resourceType: 'campaign',
    resourceId: campaign._id,
    metadata: { pausedEnrollments: result.pausedEnrollments },
  });

  res.json({ success: true, data: result });
}

// ---------------------------------------------------------------------------
// resumeCampaignHandler  POST /api/v1/workspaces/:workspaceId/campaigns/:campaignId/resume
// ---------------------------------------------------------------------------

export async function resumeCampaignHandler(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }
  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.sequenceId) throw ApiError.badRequest('Campaign has no sequence');
  const sequence = await Sequence.findOne({ _id: campaign.sequenceId, workspaceId });
  if (!sequence) throw ApiError.notFound('Associated sequence not found');

  if (campaign.status !== 'paused') {
    throw ApiError.conflict(`Campaign is ${campaign.status}, only paused campaigns can be resumed`);
  }

  const result = await resumeCampaign({
    workspaceId: new mongoose.Types.ObjectId(workspaceId!),
    campaign,
    sequence,
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'campaign.resume',
    resourceType: 'campaign',
    resourceId: campaign._id,
    metadata: { resumedEnrollments: result.resumedEnrollments },
  });

  res.json({ success: true, data: result });
}

// ---------------------------------------------------------------------------
// archiveCampaignHandler  POST /api/v1/workspaces/:workspaceId/campaigns/:campaignId/archive
// ---------------------------------------------------------------------------

export async function archiveCampaignHandler(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(campaignId!)) throw ApiError.badRequest('Invalid campaignId');

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.status === 'archived') {
    res.json({ success: true });
    return;
  }

  if (campaign.sequenceId) {
    await SequenceEnrollment.updateMany(
      { workspaceId, sequenceId: campaign.sequenceId, status: 'active' },
      { $set: { status: 'paused', stopReason: 'campaign_archived' } },
    );
  }

  campaign.status = 'archived';
  await campaign.save();

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'campaign.archive',
    resourceType: 'campaign',
    resourceId: campaign._id,
    metadata: { name: campaign.name },
  });

  res.json({ success: true });
}
