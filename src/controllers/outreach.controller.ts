import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import Campaign from '../models/Campaign.js';
import File from '../models/File.js';
import Lead from '../models/Lead.js';
import Workspace from '../models/Workspace.js';
import OutreachDraft from '../models/OutreachDraft.js';
import { ApiError } from '../utils/ApiError.js';
import { getOutreachQueue } from '../services/queue/queues.js';
import { generateOutreachDraft } from '../services/ai/outreachDraftService.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { logAudit } from '../services/audit.js';
import { sendEmailForWorkspace, textToHtml } from '../services/email/emailService.js';

// ---------------------------------------------------------------------------
// generateSingleDraft  POST /api/v1/workspaces/:workspaceId/outreach/generate
// ---------------------------------------------------------------------------

export async function generateSingleDraft(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();

  const { workspaceId } = req.params;
  const { campaignId, leadId } = req.body as { campaignId?: unknown; leadId?: unknown };

  if (typeof campaignId !== 'string' || !mongoose.Types.ObjectId.isValid(campaignId)) {
    throw ApiError.badRequest('campaignId must be a valid ObjectId');
  }
  if (typeof leadId !== 'string' || !mongoose.Types.ObjectId.isValid(leadId)) {
    throw ApiError.badRequest('leadId must be a valid ObjectId');
  }

  const [workspace, campaign, lead] = await Promise.all([
    Workspace.findById(workspaceId),
    Campaign.findOne({ _id: campaignId, workspaceId }),
    Lead.findOne({ _id: leadId, workspaceId }),
  ]);

  if (!workspace) throw ApiError.notFound('Workspace not found');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!lead) throw ApiError.notFound('Lead not found');

  // For single-draft (quick preview), skip SerpAPI research — pass [] snippets
  const snippets: string[] = [];

  const result = await generateOutreachDraft(
    {
      companyName: lead.companyName,
      companyDomain: lead.companyDomain,
      website: lead.website,
      industry: lead.industry,
      address: lead.address,
      socialProfiles: lead.socialProfiles,
    },
    {
      name: workspace.name,
      settings: { cheapMode: workspace.settings?.cheapMode },
      knowledgeBase: workspace.knowledgeBase?.map((kb) => ({
        title: kb.title,
        content: kb.content,
        type: kb.type,
      })),
    },
    {
      name: campaign.name,
      outreachConfig: {
        tone: campaign.outreachConfig?.tone,
        language: campaign.outreachConfig?.language,
        channel: campaign.outreachConfig?.channel,
      },
    },
    snippets,
  );

  const draft = await OutreachDraft.create({
    workspaceId: workspaceId!,
    campaignId,
    leadId,
    createdBy: req.user._id,
    channel: campaign.outreachConfig?.channel ?? 'email',
    firstLine: result.firstLine,
    subject: result.subject,
    body: result.body,
    tone: campaign.outreachConfig?.tone ?? 'professional',
    language: campaign.outreachConfig?.language ?? 'English',
    promptUsed: `single-draft:${campaign._id}`,
    modelResponse: JSON.stringify(result),
    reasoning: result.reasoning,
    status: 'draft',
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'outreach_draft.generate_single',
    resourceType: 'outreach_draft',
    resourceId: draft._id,
    metadata: { campaignId, leadId },
  });

  res.status(201).json({ success: true, data: draft });
}

// ---------------------------------------------------------------------------
// generateCampaignDrafts  POST /api/v1/workspaces/:workspaceId/campaigns/:campaignId/generate
// ---------------------------------------------------------------------------

export async function generateCampaignDrafts(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(campaignId!)) {
    throw ApiError.badRequest('Invalid campaignId');
  }

  const body = req.body as { tone?: unknown; language?: unknown };

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw ApiError.notFound('Campaign not found');

  const file = await File.findOne({ _id: campaign.fileId, workspaceId }).select('leadIds');
  if (!file || file.leadIds.length === 0) {
    throw ApiError.badRequest('Campaign\'s file has no leads');
  }

  // Optionally update outreachConfig tone/language if provided
  const setFields: Record<string, unknown> = {};
  if (typeof body.tone === 'string' && body.tone.trim()) {
    setFields['outreachConfig.tone'] = body.tone.trim();
  }
  if (typeof body.language === 'string' && body.language.trim()) {
    setFields['outreachConfig.language'] = body.language.trim();
  }
  if (Object.keys(setFields).length > 0) {
    await Campaign.updateOne({ _id: campaignId }, { $set: setFields });
  }

  const queue = getOutreachQueue();
  const job = await queue.add(
    'generate-outreach',
    {
      campaignId: campaign._id.toString(),
      workspaceId: workspaceId!,
      leadIds: file.leadIds.map((id) => id.toString()),
    },
    {
      // jobId = campaignId deduplicates: re-calling this endpoint while a job is queued/active
      // will return the existing job's ID rather than enqueue a duplicate run.
      jobId: campaign._id.toString(),
    },
  );

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'outreach_draft.generate_bulk',
    resourceType: 'campaign',
    resourceId: campaign._id,
    metadata: { leadCount: file.leadIds.length, bullmqJobId: job.id },
  });

  res.status(202).json({ success: true, data: { bullmqJobId: job.id } });
}

// ---------------------------------------------------------------------------
// streamCampaignGeneration  GET /api/v1/workspaces/:workspaceId/campaigns/:campaignId/generate/stream
// (SSE — NOT wrapped in asyncHandler, handles its own errors)
// ---------------------------------------------------------------------------

export async function streamCampaignGeneration(req: Request, res: Response): Promise<void> {
  const { workspaceId, campaignId } = req.params;

  if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
    res.status(400).json({ success: false, error: 'Invalid campaignId' });
    return;
  }

  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) {
    res.status(404).json({ success: false, error: 'Campaign not found' });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const fileForCount = await File.findOne({ _id: campaign.fileId, workspaceId }).select('leadIds').lean();
  const totalLeads = fileForCount?.leadIds?.length ?? 0;

  // Dedicated Redis connection for pub/sub — subscribe BEFORE bootstrap so worker
  // messages are not dropped while we await DB counts / initial sends.
  const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('error', (err) => logger.error('SSE outreach subscriber error', { err }));

  const channel = `outreach:progress:${campaignId}`;

  subscriber.on('message', (_chan: string, message: string) => {
    res.write(`data: ${message}\n\n`);
  });

  const heartbeat = setInterval(() => {
    send({ type: 'heartbeat' });
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subscriber.unsubscribe(channel).catch(() => {});
    subscriber.quit().catch(() => {});
  });

  try {
    await subscriber.subscribe(channel);
  } catch (err) {
    logger.error('SSE outreach subscribe failed', { err, campaignId });
    clearInterval(heartbeat);
    await subscriber.quit().catch(() => {});
    res.end();
    return;
  }

  const doneCount = await OutreachDraft.countDocuments({ campaignId, workspaceId });
  send({ type: 'connected', campaignId });
  send({ type: 'bootstrap', done: doneCount, total: totalLeads });

  // If the BullMQ job already finished before this connection subscribed, replay the
  // terminal event so the client does not hang on "Generating…".
  try {
    const queue = getOutreachQueue();
    const job = await queue.getJob(campaignId);
    if (job) {
      const state = await job.getState();
      if (state === 'completed') {
        const done = await OutreachDraft.countDocuments({ campaignId, workspaceId });
        send({
          type: 'generation_complete',
          campaignId,
          done,
          failed: Math.max(0, totalLeads - done),
          total: totalLeads,
        });
      } else if (state === 'failed') {
        const done = await OutreachDraft.countDocuments({ campaignId, workspaceId });
        send({
          type: 'generation_complete',
          campaignId,
          done,
          failed: Math.max(0, totalLeads - done),
          total: totalLeads,
        });
      }
    }
  } catch (err) {
    logger.warn('SSE outreach job state sync skipped', { err, campaignId });
  }
}

// ---------------------------------------------------------------------------
// listDrafts  GET /api/v1/workspaces/:workspaceId/outreach
// ---------------------------------------------------------------------------

export async function listDrafts(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;

  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10) || 20));

  const filter: Record<string, unknown> = { workspaceId };

  const campaignIdQ = req.query['campaignId'];
  if (typeof campaignIdQ === 'string') {
    if (!mongoose.Types.ObjectId.isValid(campaignIdQ)) {
      throw ApiError.badRequest('Invalid campaignId filter');
    }
    filter['campaignId'] = campaignIdQ;
  }

  const leadIdQ = req.query['leadId'];
  if (typeof leadIdQ === 'string') {
    if (!mongoose.Types.ObjectId.isValid(leadIdQ)) {
      throw ApiError.badRequest('Invalid leadId filter');
    }
    filter['leadId'] = leadIdQ;
  }

  const statusQ = req.query['status'];
  const VALID_DRAFT_STATUSES = ['draft', 'approved', 'sent', 'failed'];
  if (typeof statusQ === 'string') {
    if (!VALID_DRAFT_STATUSES.includes(statusQ)) {
      throw ApiError.badRequest(`status must be one of: ${VALID_DRAFT_STATUSES.join(', ')}`);
    }
    filter['status'] = statusQ;
  }

  const [drafts, total] = await Promise.all([
    OutreachDraft.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    OutreachDraft.countDocuments(filter),
  ]);

  res.json({ success: true, data: { data: drafts, total, page, limit } });
}

// ---------------------------------------------------------------------------
// getDraft  GET /api/v1/workspaces/:workspaceId/outreach/:draftId
// ---------------------------------------------------------------------------

export async function getDraft(req: Request, res: Response): Promise<void> {
  const { workspaceId, draftId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(draftId!)) {
    throw ApiError.badRequest('Invalid draftId');
  }

  const draft = await OutreachDraft.findOne({ _id: draftId, workspaceId });
  if (!draft) throw ApiError.notFound('Draft not found');

  res.json({ success: true, data: draft });
}

// ---------------------------------------------------------------------------
// updateDraft  PATCH /api/v1/workspaces/:workspaceId/outreach/:draftId
// ---------------------------------------------------------------------------

export async function updateDraft(req: Request, res: Response): Promise<void> {
  const { workspaceId, draftId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(draftId!)) {
    throw ApiError.badRequest('Invalid draftId');
  }

  const body = req.body as { subject?: unknown; body?: unknown; firstLine?: unknown };
  const setFields: Record<string, unknown> = {};

  if (body.subject !== undefined) {
    if (typeof body.subject !== 'string') throw ApiError.badRequest('subject must be a string');
    setFields['subject'] = body.subject;
  }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') throw ApiError.badRequest('body must be a string');
    setFields['body'] = body.body;
  }
  if (body.firstLine !== undefined) {
    if (typeof body.firstLine !== 'string') throw ApiError.badRequest('firstLine must be a string');
    setFields['firstLine'] = body.firstLine;
  }

  if (Object.keys(setFields).length === 0) {
    throw ApiError.badRequest('No valid fields to update');
  }

  const draft = await OutreachDraft.findOneAndUpdate(
    { _id: draftId, workspaceId },
    { $set: setFields },
    { new: true, runValidators: true },
  );

  if (!draft) throw ApiError.notFound('Draft not found');

  res.json({ success: true, data: draft });
}

// ---------------------------------------------------------------------------
// approveDraft  POST /api/v1/workspaces/:workspaceId/outreach/:draftId/approve
// ---------------------------------------------------------------------------

export async function approveDraft(req: Request, res: Response): Promise<void> {
  const { workspaceId, draftId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(draftId!)) {
    throw ApiError.badRequest('Invalid draftId');
  }

  const draft = await OutreachDraft.findOneAndUpdate(
    { _id: draftId, workspaceId },
    { $set: { status: 'approved' } },
    { new: true },
  );

  if (!draft) throw ApiError.notFound('Draft not found');

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'outreach_draft.approve',
    resourceType: 'outreach_draft',
    resourceId: draft._id,
  });

  res.json({ success: true, data: draft });
}

// ---------------------------------------------------------------------------
// deleteDraft  DELETE /api/v1/workspaces/:workspaceId/outreach/:draftId
// ---------------------------------------------------------------------------

export async function deleteDraft(req: Request, res: Response): Promise<void> {
  const { workspaceId, draftId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(draftId!)) {
    throw ApiError.badRequest('Invalid draftId');
  }

  const draft = await OutreachDraft.findOneAndDelete({ _id: draftId, workspaceId });
  if (!draft) throw ApiError.notFound('Draft not found');

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'outreach_draft.delete',
    resourceType: 'outreach_draft',
    resourceId: draft._id,
    metadata: { campaignId: draft.campaignId?.toString(), leadId: draft.leadId?.toString() },
  });

  res.json({ success: true });
}

// ---------------------------------------------------------------------------
// sendDraft  POST /api/v1/workspaces/:workspaceId/outreach/:draftId/send
// ---------------------------------------------------------------------------

export async function sendDraft(req: Request, res: Response): Promise<void> {
  const { workspaceId, draftId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(draftId!)) {
    throw ApiError.badRequest('Invalid draftId');
  }

  const draft = await OutreachDraft.findOne({ _id: draftId, workspaceId });
  if (!draft) throw ApiError.notFound('Draft not found');

  if (draft.status === 'sent') {
    throw ApiError.conflict('Draft has already been sent');
  }
  if (draft.status !== 'approved') {
    throw ApiError.badRequest('Draft must be approved before sending');
  }

  // Load workspace email config (select secret fields explicitly)
  const workspace = await Workspace.findById(workspaceId).select('+emailConfig.apiKey +emailConfig.smtpPass +emailConfig.gmail.accessToken +emailConfig.gmail.refreshToken');
  if (!workspace) throw ApiError.notFound('Workspace not found');

  if (!workspace.emailConfig?.provider || !workspace.emailConfig.fromEmail) {
    throw ApiError.badRequest(
      'Email is not configured for this workspace. Go to Settings → Email to set up your sending account.'
    );
  }

  // Load lead to get recipient address
  const lead = await Lead.findOne({ _id: draft.leadId, workspaceId });
  if (!lead) throw ApiError.notFound('Lead not found');

  if (!lead.emails || lead.emails.length === 0) {
    throw ApiError.badRequest('Lead has no email address on record');
  }

  // Prefer highest-confidence business email, then any
  const sortedEmails = [...lead.emails].sort((a, b) => {
    const businessBonus = (e: typeof a) => (e.type === 'business' ? 1 : 0);
    return (businessBonus(b) - businessBonus(a)) || (b.confidence - a.confidence);
  });
  const toAddress = sortedEmails[0]!.address;

  const subject = draft.subject ?? `Hello from ${workspace.name}`;
  const { messageId } = await sendEmailForWorkspace(workspace.emailConfig, {
    to: toAddress,
    subject,
    html: textToHtml(draft.body),
    text: draft.body,
    workspaceId: workspaceId as string,
  });

  const sent = await OutreachDraft.findByIdAndUpdate(
    draftId,
    {
      $set: {
        status: 'sent',
        sentAt: new Date(),
        'deliveryMetadata.provider': workspace.emailConfig.provider,
        'deliveryMetadata.messageId': messageId,
      },
    },
    { new: true },
  );

  // Mark the lead as contacted
  await Lead.updateOne({ _id: draft.leadId }, { $set: { outreachStatus: 'contacted' } });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'outreach_draft.send',
    resourceType: 'outreach_draft',
    resourceId: draft._id,
    metadata: { to: toAddress, messageId, provider: workspace.emailConfig.provider },
  });

  res.json({ success: true, data: sent });
}
