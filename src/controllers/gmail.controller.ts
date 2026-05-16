import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import { ApiError } from '../utils/ApiError.js';
import { encrypt, decrypt } from '../utils/encrypt.js';
import { env } from '../config/env.js';

// GET /workspaces/:workspaceId/email-sender/gmail/connect
export async function gmailConnect(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.send email profile',
    access_type: 'offline',
    prompt: 'consent',
    state: workspaceId!,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

// GET /api/v1/oauth/gmail/callback  (top-level, no auth middleware)
export async function gmailCallback(req: Request, res: Response): Promise<void> {
  const code = req.query['code'] as string;
  const workspaceId = req.query['state'] as string;

  if (!code || !workspaceId) throw ApiError.badRequest('Missing code or state');
  if (!mongoose.Types.ObjectId.isValid(workspaceId)) throw ApiError.badRequest('Invalid state');

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI ?? '',
    grant_type: 'authorization_code',
  });

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    throw ApiError.badRequest(`Google OAuth exchange failed: ${err}`);
  }

  const tokens = await tokenResp.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  // Fetch the connected account email address
  const userinfoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userinfo = userinfoResp.ok
    ? (await userinfoResp.json() as { email?: string; name?: string })
    : { email: undefined, name: undefined };

  const update: Record<string, unknown> = {
    'emailConfig.provider': 'gmail',
    'emailConfig.fromEmail': userinfo.email ?? '',
    'emailConfig.fromName': userinfo.name ?? 'Me',
    'emailConfig.gmail.accessToken': encrypt(tokens.access_token),
    'emailConfig.gmail.expiresAt': new Date(Date.now() + tokens.expires_in * 1000),
    'emailConfig.gmail.email': userinfo.email,
  };
  if (tokens.refresh_token) {
    update['emailConfig.gmail.refreshToken'] = encrypt(tokens.refresh_token);
  }

  await Workspace.findByIdAndUpdate(workspaceId, { $set: update });

  res.redirect(`${env.FRONTEND_URL}/dashboard/settings/email?gmail=connected`);
}

// GET /workspaces/:workspaceId/email-sender/gmail/status
export async function gmailStatus(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const workspace = await Workspace.findById(workspaceId)
    .select('emailConfig.provider emailConfig.fromEmail emailConfig.fromName emailConfig.gmail.email emailConfig.gmail.expiresAt');

  if (workspace?.emailConfig?.provider !== 'gmail' || !workspace.emailConfig?.gmail?.email) {
    res.json({ success: true, data: { connected: false } });
    return;
  }

  res.json({
    success: true,
    data: {
      connected: true,
      email: workspace.emailConfig.gmail.email,
      fromName: workspace.emailConfig.fromName,
      tokenExpiresAt: workspace.emailConfig.gmail.expiresAt,
    },
  });
}

// DELETE /workspaces/:workspaceId/email-sender/gmail/disconnect
export async function gmailDisconnect(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  await Workspace.findByIdAndUpdate(workspaceId, {
    $unset: { 'emailConfig.gmail': 1 },
    $set: { 'emailConfig.provider': null },
  });
  res.json({ success: true });
}

// ─── Send utility (used by campaign / sequence workers) ─────────────────────

interface GmailSendParams {
  workspaceId: string;
  to: string;
  subject: string;
  html: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
}

interface GmailTokens {
  accessToken: string;        // encrypted
  refreshToken?: string;      // encrypted
  expiresAt?: Date;
}

async function refreshGmailToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    refresh_token: refreshToken,
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error('Gmail token refresh failed');
  const data = await resp.json() as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

export async function sendViaGmail(tokens: GmailTokens, params: GmailSendParams): Promise<string> {
  let accessToken = decrypt(tokens.accessToken);

  // Refresh if within 5 minutes of expiry
  if (tokens.refreshToken && tokens.expiresAt) {
    const fiveMin = 5 * 60 * 1000;
    if (tokens.expiresAt.getTime() - Date.now() < fiveMin) {
      const refreshed = await refreshGmailToken(decrypt(tokens.refreshToken));
      accessToken = refreshed.accessToken;
      // Persist refreshed token
      await Workspace.findByIdAndUpdate(params.workspaceId, {
        $set: {
          'emailConfig.gmail.accessToken': encrypt(refreshed.accessToken),
          'emailConfig.gmail.expiresAt': refreshed.expiresAt,
        },
      });
    }
  }

  // Build RFC 2822 message
  const from = params.fromName
    ? `${params.fromName} <${params.fromEmail}>`
    : (params.fromEmail ?? '');

  const lines = [
    `From: ${from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    ...(params.replyTo ? [`Reply-To: ${params.replyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    params.html,
  ];
  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sendResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!sendResp.ok) {
    const errBody = await sendResp.text();
    throw new Error(`Gmail send failed (${sendResp.status}): ${errBody}`);
  }

  const result = await sendResp.json() as { id: string };
  return result.id;
}
