import nodemailer from 'nodemailer';
import { decrypt } from '../../utils/encrypt.js';
import { logger } from '../../utils/logger.js';
import type { IEmailConfig } from '../../models/Workspace.js';

export interface EmailPreflightResult {
  ok: boolean;
  provider: string;
  reason?: string;
  /** Optional diagnostic — e.g., the Resend account email returned by /domains. */
  details?: Record<string, unknown>;
}

/**
 * Live-test the workspace's email credentials before we accept enrollments
 * into a campaign. The pre-fix flow let `campaigns.activate` succeed even
 * when the Resend key was wrong or the Gmail refresh token was revoked —
 * users would see "Campaign active" + 0 sends forever.
 *
 * Each provider does the cheapest possible authenticated probe:
 *   - resend: GET /domains (returns 200 on valid key, 401/403 on bad).
 *   - sendgrid: GET /v3/user/profile (same pattern).
 *   - gmail:   POST /token with the workspace's refresh_token (issues a
 *              fresh access token if the refresh token is still authorised).
 *   - smtp:    nodemailer.verify() — TLS handshake + AUTH, no actual send.
 *
 * Designed to be fast (< 1s typical) and idempotent. Never sends an email.
 */
export async function preflightEmailProvider(
  config: IEmailConfig & { apiKey?: string; smtpPass?: string },
): Promise<EmailPreflightResult> {
  const provider = config.provider ?? 'unknown';
  if (!config.fromEmail) {
    return { ok: false, provider, reason: 'fromEmail not configured' };
  }

  try {
    if (provider === 'resend') {
      if (!config.apiKey) return { ok: false, provider, reason: 'Resend API key missing' };
      const apiKey = decrypt(config.apiKey);
      const res = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        return { ok: false, provider, reason: `Resend rejected key (status ${res.status})` };
      }
      return { ok: true, provider };
    }

    if (provider === 'sendgrid') {
      if (!config.apiKey) return { ok: false, provider, reason: 'SendGrid API key missing' };
      const apiKey = decrypt(config.apiKey);
      const res = await fetch('https://api.sendgrid.com/v3/user/profile', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        return { ok: false, provider, reason: `SendGrid rejected key (status ${res.status})` };
      }
      return { ok: true, provider };
    }

    if (provider === 'gmail') {
      // Cast — the IEmailConfig type doesn't currently expose the gmail
      // sub-document because it lives behind a `select: false` field; the
      // caller is expected to project it in.
      const gmailCfg = (config as unknown as {
        gmail?: { refreshToken?: string; accessToken?: string; email?: string };
      }).gmail;
      if (!gmailCfg?.refreshToken) {
        return { ok: false, provider, reason: 'Gmail refresh token missing — reconnect required' };
      }
      const refreshToken = decrypt(gmailCfg.refreshToken);
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? '',
        client_secret: process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? '',
        refresh_token: refreshToken,
      });
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) {
        return { ok: false, provider, reason: `Gmail refresh failed (status ${res.status}) — reconnect required` };
      }
      return { ok: true, provider, details: { email: gmailCfg.email } };
    }

    if (provider === 'smtp') {
      if (!config.smtpHost) return { ok: false, provider, reason: 'SMTP host not configured' };
      const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort ?? 587,
        secure: config.smtpSecure ?? false,
        auth: config.smtpUser
          ? { user: config.smtpUser, pass: config.smtpPass ? decrypt(config.smtpPass) : '' }
          : undefined,
        // Bound the probe so a wedged TCP connect doesn't hang activation.
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 5_000,
      });
      await transporter.verify();
      return { ok: true, provider };
    }

    return { ok: false, provider, reason: `Unsupported provider: ${provider}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('[email-preflight] probe threw', { provider, reason });
    return { ok: false, provider, reason };
  }
}
