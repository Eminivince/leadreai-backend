import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import Lead from '../models/Lead.js';
import { ApiError } from '../utils/ApiError.js';
import { encrypt } from '../utils/encrypt.js';
import { logAudit } from '../services/audit.js';
import { getHubspotSyncQueue } from '../services/queue/queues.js';
import { env } from '../config/env.js';

// GET /crm/hubspot/connect
// Redirects to HubSpot OAuth authorize URL
// State param = workspaceId (so callback knows which workspace to update)
export async function hubspotConnect(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const params = new URLSearchParams({
    client_id: env.HUBSPOT_CLIENT_ID ?? '',
    redirect_uri: env.HUBSPOT_REDIRECT_URI ?? '',
    scope: 'crm.objects.companies.read crm.objects.companies.write crm.objects.contacts.read crm.objects.contacts.write',
    state: workspaceId!,
  });
  res.redirect(`https://app.hubspot.com/oauth/authorize?${params}`);
}

// GET /crm/hubspot/callback
// Exchanges code for tokens, encrypts and stores in workspace.crmConfig
// Then redirects to frontend: ${env.FRONTEND_URL}/dashboard/integrations?crm=connected
export async function hubspotCallback(req: Request, res: Response): Promise<void> {
  const code = req.query['code'] as string;
  const workspaceId = req.query['state'] as string;
  if (!code || !workspaceId) throw ApiError.badRequest('Missing code or state');

  if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
    throw ApiError.badRequest('Invalid state parameter');
  }

  // Exchange code for tokens
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.HUBSPOT_CLIENT_ID ?? '',
    client_secret: env.HUBSPOT_CLIENT_SECRET ?? '',
    redirect_uri: env.HUBSPOT_REDIRECT_URI ?? '',
    code,
  });
  const resp = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) throw ApiError.badRequest('HubSpot OAuth exchange failed');
  const data = await resp.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    hub_id: number;
  };

  // Encrypt tokens
  const encryptedAccess = encrypt(data.access_token);
  const encryptedRefresh = encrypt(data.refresh_token);

  await Workspace.findByIdAndUpdate(workspaceId, {
    $set: {
      'crmConfig.provider': 'hubspot',
      'crmConfig.hubspot.accessToken': encryptedAccess,
      'crmConfig.hubspot.refreshToken': encryptedRefresh,
      'crmConfig.hubspot.expiresAt': new Date(Date.now() + data.expires_in * 1000),
      'crmConfig.hubspot.portalId': String(data.hub_id),
      'crmConfig.hubspot.syncEnabled': true,
      'crmConfig.hubspot.autoSyncOnJobComplete': false,
      'crmConfig.hubspot.syncLog': [],
    },
  });

  res.redirect(`${env.FRONTEND_URL}/dashboard/integrations?crm=connected`);
}

// GET /crm/hubspot/status
// Returns { connected, portalId, syncEnabled, autoSyncOnJobComplete, lastSyncAt, tokenExpiresAt }
export async function hubspotStatus(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const workspace = await Workspace.findById(workspaceId);

  if (!workspace?.crmConfig?.hubspot?.portalId) {
    res.json({ success: true, data: { connected: false } });
    return;
  }

  const hs = workspace.crmConfig.hubspot;
  res.json({
    success: true,
    data: {
      connected: true,
      portalId: hs.portalId,
      syncEnabled: hs.syncEnabled,
      autoSyncOnJobComplete: hs.autoSyncOnJobComplete,
      lastSyncAt: hs.lastSyncAt,
      tokenExpiresAt: hs.expiresAt,
    },
  });
}

// DELETE /crm/hubspot/disconnect
// Clears workspace.crmConfig
export async function hubspotDisconnect(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  if (!workspaceId) throw ApiError.badRequest('workspaceId required');
  await Workspace.findByIdAndUpdate(workspaceId, { $unset: { crmConfig: 1 } });
  logAudit({
    req,
    workspaceId,
    action: 'crm.hubspot.disconnect',
    resourceType: 'workspace',
    resourceId: new mongoose.Types.ObjectId(workspaceId),
  });
  res.json({ success: true });
}

// POST /crm/hubspot/sync
// Enqueues hubspot-sync BullMQ job, returns { jobId }
export async function triggerHubspotSync(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const job = await getHubspotSyncQueue().add(
    'sync',
    { workspaceId, direction: 'push', triggeredBy: 'manual' },
    { attempts: 2, backoff: { type: 'exponential', delay: 30000 } }
  );
  res.json({ success: true, data: { jobId: job.id } });
}

// POST /leads/:leadId/crm-push
// Enqueues a hubspot-sync job for just this one lead
export async function pushLeadToCrm(req: Request, res: Response): Promise<void> {
  const { workspaceId, leadId } = req.params;

  if (!leadId || !mongoose.Types.ObjectId.isValid(leadId)) {
    throw ApiError.badRequest('Invalid leadId');
  }

  const lead = await Lead.findOne({ _id: leadId, workspaceId });
  if (!lead) throw ApiError.notFound('Lead not found');

  const job = await getHubspotSyncQueue().add(
    'sync',
    { workspaceId, direction: 'push', leadIds: [leadId], triggeredBy: 'manual' },
    { attempts: 2, backoff: { type: 'exponential', delay: 30000 } }
  );
  res.json({ success: true, data: { jobId: job.id } });
}

// GET /crm/hubspot/sync-log
// Returns workspace.crmConfig.hubspot.syncLog (last 50 entries)
export async function getSyncLog(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const workspace = await Workspace.findById(workspaceId).select('crmConfig.hubspot.syncLog');
  res.json({ success: true, data: workspace?.crmConfig?.hubspot?.syncLog ?? [] });
}
