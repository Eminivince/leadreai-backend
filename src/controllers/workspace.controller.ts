import { randomBytes, createHash } from 'crypto';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Workspace, { type EmailProvider } from '../models/Workspace.js';
import { ApiError } from '../utils/ApiError.js';
import { KNOWLEDGE_BASE_ENTRY_TYPES, type KnowledgeBaseEntryType } from '../../shared/index.js';
import { encrypt } from '../utils/encrypt.js';

export async function listWorkspaces(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const workspaces = await Workspace.find({
    $or: [
      { ownerId: req.user._id },
      { 'members.userId': req.user._id },
    ],
  }).select('-settings.webhookUrl');
  res.json({ success: true, data: workspaces });
}

export async function getWorkspace(req: Request, res: Response): Promise<void> {
  const workspace = await Workspace.findById(req.params['workspaceId'])
    .select('-settings.webhookUrl -usageStats');
  if (!workspace) throw ApiError.notFound('Workspace not found');
  res.json({ success: true, data: workspace });
}

export async function createWorkspace(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { name } = req.body as { name: string };
  if (!name?.trim()) throw ApiError.badRequest('name is required');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + randomBytes(4).toString('hex');
  try {
    const workspace = await Workspace.create({
      name: name.trim(),
      slug,
      ownerId: req.user._id,
      members: [{ userId: req.user._id, role: 'owner', joinedAt: new Date() }],
    });
    res.status(201).json({ success: true, data: workspace });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: number }).code === 11000) {
      throw ApiError.conflict('Workspace name already in use');
    }
    throw err;
  }
}

export async function updateWorkspace(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const body = req.body as {
    name?: string;
    description?: string;
    clientLabel?: string;
    branding?: {
      displayName?: string;
      logoUrl?: string;
      contactEmail?: string;
      reportTitle?: string;
    };
    budget?: {
      monthlyCapUSD?: number | null;
      alertThresholdPct?: number;
    };
    settings?: {
      cheapMode?: boolean;
      defaultExportFormat?: 'csv' | 'xlsx';
      notifyOnJobComplete?: boolean;
    };
  };

  const setFields: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw ApiError.badRequest('name must be a non-empty string');
    }
    setFields['name'] = body.name.trim();
  }

  if (body.description !== undefined) {
    setFields['description'] = body.description;
  }

  if (body.clientLabel !== undefined) {
    if (typeof body.clientLabel !== 'string') {
      throw ApiError.badRequest('clientLabel must be a string');
    }
    setFields['clientLabel'] = body.clientLabel.trim().slice(0, 200);
  }

  if (body.branding !== undefined) {
    // Whole-block replacement — the frontend always sends a complete
    // branding object so partial-update merging isn't needed.
    setFields['branding'] = {
      displayName: body.branding.displayName?.slice(0, 200),
      logoUrl: body.branding.logoUrl?.slice(0, 1024),
      contactEmail: body.branding.contactEmail?.slice(0, 320),
      reportTitle: body.branding.reportTitle?.slice(0, 240),
    };
  }

  // Audit retention (Task #21). 0 means "keep forever"; otherwise we
  // accept 1–3650 (10 years). The audit writer caches this per
  // workspace for 5 minutes so changes propagate quickly.
  const bodyWithRetention = body as typeof body & { auditRetentionDays?: number | null };
  if (bodyWithRetention.auditRetentionDays !== undefined) {
    if (bodyWithRetention.auditRetentionDays === null) {
      setFields['auditRetentionDays'] = undefined;
    } else if (typeof bodyWithRetention.auditRetentionDays === 'number') {
      const days = bodyWithRetention.auditRetentionDays;
      if (days < 0 || days > 3650 || !Number.isInteger(days)) {
        throw ApiError.badRequest('auditRetentionDays must be an integer 0–3650');
      }
      setFields['auditRetentionDays'] = days;
    }
  }

  if (body.budget !== undefined) {
    // Cap setter (Task #15). Passing monthlyCapUSD: null clears the
    // budget; passing a number sets it. alertedAt is cleared on any
    // setter so a re-armed budget gets a fresh first-fire.
    if (body.budget.monthlyCapUSD === null) {
      setFields['budget'] = undefined;
    } else if (typeof body.budget.monthlyCapUSD === 'number') {
      if (body.budget.monthlyCapUSD < 0) {
        throw ApiError.badRequest('budget.monthlyCapUSD must be >= 0');
      }
      const threshold = body.budget.alertThresholdPct ?? 80;
      if (threshold < 1 || threshold > 100) {
        throw ApiError.badRequest('budget.alertThresholdPct must be 1–100');
      }
      setFields['budget'] = {
        monthlyCapUSD: body.budget.monthlyCapUSD,
        alertThresholdPct: threshold,
      };
    } else if (body.budget.alertThresholdPct !== undefined) {
      // Threshold-only update preserves the cap.
      setFields['budget.alertThresholdPct'] = body.budget.alertThresholdPct;
    }
  }

  if (body.settings !== undefined) {
    const { cheapMode, defaultExportFormat, notifyOnJobComplete } = body.settings;

    if (cheapMode !== undefined) {
      if (typeof cheapMode !== 'boolean') {
        throw ApiError.badRequest('settings.cheapMode must be a boolean');
      }
      setFields['settings.cheapMode'] = cheapMode;
    }

    if (defaultExportFormat !== undefined) {
      if (!['csv', 'xlsx'].includes(defaultExportFormat)) {
        throw ApiError.badRequest('settings.defaultExportFormat must be "csv" or "xlsx"');
      }
      setFields['settings.defaultExportFormat'] = defaultExportFormat;
    }

    if (notifyOnJobComplete !== undefined) {
      if (typeof notifyOnJobComplete !== 'boolean') {
        throw ApiError.badRequest('settings.notifyOnJobComplete must be a boolean');
      }
      setFields['settings.notifyOnJobComplete'] = notifyOnJobComplete;
    }
  }

  if (Object.keys(setFields).length === 0) {
    throw ApiError.badRequest('No valid fields to update');
  }

  const workspace = await Workspace.findByIdAndUpdate(
    workspaceId,
    { $set: setFields },
    { new: true, runValidators: true }
  ).select('-settings.webhookUrl -usageStats');

  if (!workspace) throw ApiError.notFound('Workspace not found');

  res.json({ success: true, data: workspace });
}

export async function deleteWorkspace(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } });
}

/* ── Multi-client agency mode (Task #11) ─────────────────────────── */

/**
 * List client sub-workspaces under a parent. Only the parent's owner /
 * admin can see this list — clients show in their own listWorkspaces
 * response too (because membership inherits), but agency dashboards
 * want a single "your clients" surface.
 */
export async function listClientWorkspaces(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) {
    throw ApiError.badRequest('Invalid workspaceId');
  }
  const clients = await Workspace.find({
    parentWorkspaceId: workspaceId,
    isClient: true,
  })
    .select('-settings.webhookUrl -usageStats')
    .sort({ createdAt: -1 });
  res.json({ success: true, data: clients });
}

/**
 * Create a client sub-workspace under the current workspace. The caller
 * (owner/admin of the parent) automatically becomes the new workspace's
 * owner — but the agency owner-inheritance rule in `authorize` means
 * other parent admins also retain access without being explicit members.
 */
export async function createClientWorkspace(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) {
    throw ApiError.badRequest('Invalid workspaceId');
  }

  const parent = await Workspace.findById(workspaceId).select('isClient');
  if (!parent) throw ApiError.notFound('Parent workspace not found');
  // A client workspace can't have its own clients — keeps the tree
  // flat so RBAC + billing logic stays comprehensible.
  if (parent.isClient) {
    throw ApiError.badRequest('Cannot nest a client workspace under another client');
  }

  const body = req.body as { name?: string; clientLabel?: string };
  const name = body.name?.trim();
  if (!name) throw ApiError.badRequest('name is required');

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + randomBytes(4).toString('hex');

  try {
    const client = await Workspace.create({
      name,
      slug,
      ownerId: req.user._id,
      parentWorkspaceId: workspaceId,
      isClient: true,
      clientLabel: body.clientLabel?.trim().slice(0, 200),
      members: [{ userId: req.user._id, role: 'owner', joinedAt: new Date() }],
    });
    res.status(201).json({ success: true, data: client });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: number }).code === 11000) {
      throw ApiError.conflict('Workspace name already in use');
    }
    throw err;
  }
}

export async function listKnowledgeBase(req: Request, res: Response): Promise<void> {
  const workspace = await Workspace.findById(req.params['workspaceId'])
    .select('knowledgeBase');
  if (!workspace) throw ApiError.notFound('Workspace not found');

  const kb = workspace.knowledgeBase ?? [];
  const entries = [...kb].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  res.json({ success: true, data: entries });
}

export async function createKnowledgeBaseEntry(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const { title, content, type } = req.body as {
    title?: string;
    content?: string;
    type?: KnowledgeBaseEntryType;
  };

  if (!title || typeof title !== 'string' || !title.trim()) {
    throw ApiError.badRequest('title is required');
  }
  if (title.trim().length > 200) {
    throw ApiError.badRequest('title must be 200 characters or fewer');
  }
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw ApiError.badRequest('content is required');
  }
  if (content.length > 2000) {
    throw ApiError.badRequest('content must be 2000 characters or fewer');
  }
  if (!type || !(KNOWLEDGE_BASE_ENTRY_TYPES as readonly string[]).includes(type)) {
    throw ApiError.badRequest(
      `type must be one of: ${KNOWLEDGE_BASE_ENTRY_TYPES.join(', ')}`
    );
  }

  const now = new Date();
  const newEntry = {
    title: title.trim(),
    content,
    type,
    createdAt: now,
    updatedAt: now,
  };

  // Atomic: only push if < 20 entries, preventing races ($ifNull: older workspaces may omit knowledgeBase)
  const updated = await Workspace.findOneAndUpdate(
    {
      _id: workspaceId,
      $expr: { $lt: [{ $size: { $ifNull: ['$knowledgeBase', []] } }, 20] },
    },
    { $push: { knowledgeBase: { $each: [newEntry], $position: 0 } } },
    { new: true, runValidators: true }
  ).select('knowledgeBase');

  if (!updated) {
    const exists = await Workspace.exists({ _id: workspaceId });
    if (!exists) throw ApiError.notFound('Workspace not found');
    throw ApiError.conflict('Knowledge base limit of 20 entries reached');
  }

  const created = updated.knowledgeBase[0];
  res.status(201).json({ success: true, data: created });
}

export async function updateKnowledgeBaseEntry(req: Request, res: Response): Promise<void> {
  const { workspaceId, entryId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(entryId!)) throw ApiError.badRequest('Invalid entryId');
  const { title, content, type } = req.body as {
    title?: string;
    content?: string;
    type?: KnowledgeBaseEntryType;
  };

  const setFields: Record<string, unknown> = {};

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      throw ApiError.badRequest('title must be a non-empty string');
    }
    if (title.trim().length > 200) {
      throw ApiError.badRequest('title must be 200 characters or fewer');
    }
    setFields['knowledgeBase.$[elem].title'] = title.trim();
  }

  if (content !== undefined) {
    if (typeof content !== 'string' || !content.trim()) {
      throw ApiError.badRequest('content must be a non-empty string');
    }
    if (content.length > 2000) {
      throw ApiError.badRequest('content must be 2000 characters or fewer');
    }
    setFields['knowledgeBase.$[elem].content'] = content;
  }

  if (type !== undefined) {
    if (!(KNOWLEDGE_BASE_ENTRY_TYPES as readonly string[]).includes(type)) {
      throw ApiError.badRequest(
        `type must be one of: ${KNOWLEDGE_BASE_ENTRY_TYPES.join(', ')}`
      );
    }
    setFields['knowledgeBase.$[elem].type'] = type;
  }

  if (Object.keys(setFields).length === 0) {
    throw ApiError.badRequest('No valid fields to update');
  }

  setFields['knowledgeBase.$[elem].updatedAt'] = new Date();

  const updated = await Workspace.findByIdAndUpdate(
    workspaceId,
    { $set: setFields },
    {
      new: true,
      arrayFilters: [{ 'elem._id': new mongoose.Types.ObjectId(entryId) }],
      runValidators: true,
    }
  ).select('knowledgeBase');

  if (!updated) throw ApiError.notFound('Workspace not found');

  const updatedEntry = updated.knowledgeBase.find(
    (e) => e._id.toString() === entryId
  );
  if (!updatedEntry) throw ApiError.notFound('Knowledge base entry not found');

  res.json({ success: true, data: updatedEntry });
}

export async function deleteKnowledgeBaseEntry(req: Request, res: Response): Promise<void> {
  const { workspaceId, entryId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(entryId!)) throw ApiError.badRequest('Invalid entryId');

  const result = await Workspace.updateOne(
    { _id: workspaceId },
    { $pull: { knowledgeBase: { _id: new mongoose.Types.ObjectId(entryId) } } }
  );

  if (result.matchedCount === 0) throw ApiError.notFound('Workspace not found');
  if (result.modifiedCount === 0) throw ApiError.notFound('Knowledge base entry not found');

  res.json({ success: true });
}

// ---------------------------------------------------------------------------
// getEmailConfig  GET /api/v1/workspaces/:workspaceId/email-config
// Returns config WITHOUT secret fields (apiKey / smtpPass are never sent to client)
// ---------------------------------------------------------------------------

export async function getEmailConfig(req: Request, res: Response): Promise<void> {
  const workspace = await Workspace.findById(req.params['workspaceId']).select('emailConfig');
  if (!workspace) throw ApiError.notFound('Workspace not found');

  const cfg = workspace.emailConfig;
  if (!cfg?.provider) {
    res.json({ success: true, data: null });
    return;
  }

  // Strip encrypted secrets — client only needs non-secret metadata
  res.json({
    success: true,
    data: {
      provider: cfg.provider,
      fromEmail: cfg.fromEmail,
      fromName: cfg.fromName,
      replyTo: cfg.replyTo,
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpSecure: cfg.smtpSecure,
      smtpUser: cfg.smtpUser,
      verifiedAt: cfg.verifiedAt,
      // apiKey and smtpPass intentionally omitted
      hasApiKey: !!cfg.apiKey,
      hasSmtpPass: !!cfg.smtpPass,
    },
  });
}

// ---------------------------------------------------------------------------
// updateEmailConfig  PUT /api/v1/workspaces/:workspaceId/email-config
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: EmailProvider[] = ['smtp', 'resend', 'sendgrid'];

export async function updateEmailConfig(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;

  const body = req.body as {
    provider?: unknown;
    fromEmail?: unknown;
    fromName?: unknown;
    replyTo?: unknown;
    apiKey?: unknown;
    smtpHost?: unknown;
    smtpPort?: unknown;
    smtpSecure?: unknown;
    smtpUser?: unknown;
    smtpPass?: unknown;
  };

  if (!body.provider || !VALID_PROVIDERS.includes(body.provider as EmailProvider)) {
    throw ApiError.badRequest(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  const provider = body.provider as EmailProvider;

  if (!body.fromEmail || typeof body.fromEmail !== 'string') {
    throw ApiError.badRequest('fromEmail is required');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.fromEmail)) {
    throw ApiError.badRequest('fromEmail must be a valid email address');
  }
  if (!body.fromName || typeof body.fromName !== 'string' || !String(body.fromName).trim()) {
    throw ApiError.badRequest('fromName is required');
  }

  const setFields: Record<string, unknown> = {
    'emailConfig.provider': provider,
    'emailConfig.fromEmail': body.fromEmail,
    'emailConfig.fromName': String(body.fromName).trim(),
    'emailConfig.replyTo': body.replyTo ?? undefined,
    'emailConfig.verifiedAt': undefined,
  };

  if (provider === 'resend' || provider === 'sendgrid') {
    if (body.apiKey !== undefined) {
      if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
        throw ApiError.badRequest('apiKey must be a non-empty string');
      }
      setFields['emailConfig.apiKey'] = encrypt(body.apiKey.trim());
    }
  }

  if (provider === 'smtp') {
    if (!body.smtpHost || typeof body.smtpHost !== 'string') {
      throw ApiError.badRequest('smtpHost is required for SMTP provider');
    }
    setFields['emailConfig.smtpHost'] = body.smtpHost;
    setFields['emailConfig.smtpPort'] = typeof body.smtpPort === 'number' ? body.smtpPort : 587;
    setFields['emailConfig.smtpSecure'] = body.smtpSecure === true;
    if (body.smtpUser !== undefined) {
      setFields['emailConfig.smtpUser'] = body.smtpUser;
    }
    if (body.smtpPass !== undefined) {
      if (typeof body.smtpPass !== 'string' || !body.smtpPass.trim()) {
        throw ApiError.badRequest('smtpPass must be a non-empty string');
      }
      setFields['emailConfig.smtpPass'] = encrypt(body.smtpPass.trim());
    }
  }

  const workspace = await Workspace.findByIdAndUpdate(
    workspaceId,
    { $set: setFields },
    { new: true }
  ).select('emailConfig');

  if (!workspace) throw ApiError.notFound('Workspace not found');

  res.json({
    success: true,
    data: {
      provider: workspace.emailConfig?.provider,
      fromEmail: workspace.emailConfig?.fromEmail,
      fromName: workspace.emailConfig?.fromName,
      replyTo: workspace.emailConfig?.replyTo,
      smtpHost: workspace.emailConfig?.smtpHost,
      smtpPort: workspace.emailConfig?.smtpPort,
      smtpSecure: workspace.emailConfig?.smtpSecure,
      smtpUser: workspace.emailConfig?.smtpUser,
    },
  });
}

// ---------------------------------------------------------------------------
// deleteEmailConfig  DELETE /api/v1/workspaces/:workspaceId/email-config
// ---------------------------------------------------------------------------

export async function deleteEmailConfig(req: Request, res: Response): Promise<void> {
  const result = await Workspace.updateOne(
    { _id: req.params['workspaceId'] },
    { $unset: { emailConfig: 1 } }
  );
  if (result.matchedCount === 0) throw ApiError.notFound('Workspace not found');
  res.json({ success: true });
}

// ---------------------------------------------------------------------------
// listApiKeys  GET /api/v1/workspaces/:workspaceId/api-keys
// ---------------------------------------------------------------------------

export async function listApiKeys(req: Request, res: Response): Promise<void> {
  const workspace = await Workspace.findById(req.params['workspaceId']).select('apiKeys');
  if (!workspace) throw ApiError.notFound('Workspace not found');

  const keys = (workspace.apiKeys ?? []).map((k) => ({
    _id: k._id,
    name: k.name,
    prefix: k.prefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
  }));
  res.json({ success: true, data: keys });
}

// ---------------------------------------------------------------------------
// createApiKey  POST /api/v1/workspaces/:workspaceId/api-keys
// ---------------------------------------------------------------------------

export async function createApiKey(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const { name } = req.body as { name?: string };

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw ApiError.badRequest('name is required');
  }

  const workspace = await Workspace.findById(workspaceId).select('apiKeys');
  if (!workspace) throw ApiError.notFound('Workspace not found');
  if ((workspace.apiKeys ?? []).length >= 10) {
    throw ApiError.conflict('Maximum of 10 API keys per workspace');
  }

  const rawKey = `sk-${randomBytes(20).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const prefix = rawKey.slice(0, 8);

  await Workspace.findByIdAndUpdate(workspaceId, {
    $push: {
      apiKeys: { name: name.trim(), keyHash, prefix, createdAt: new Date() },
    },
  });

  res.status(201).json({ success: true, data: { key: rawKey, prefix, name: name.trim() } });
}

// ---------------------------------------------------------------------------
// revokeApiKey  DELETE /api/v1/workspaces/:workspaceId/api-keys/:keyId
// ---------------------------------------------------------------------------

export async function revokeApiKey(req: Request, res: Response): Promise<void> {
  const { workspaceId, keyId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(keyId!)) throw ApiError.badRequest('Invalid keyId');

  const result = await Workspace.updateOne(
    { _id: workspaceId },
    { $pull: { apiKeys: { _id: new mongoose.Types.ObjectId(keyId) } } }
  );
  if (result.matchedCount === 0) throw ApiError.notFound('Workspace not found');
  if (result.modifiedCount === 0) throw ApiError.notFound('API key not found');

  res.json({ success: true });
}
