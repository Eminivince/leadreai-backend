import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { decrypt } from '../../utils/encrypt.js';
import { logger } from '../../utils/logger.js';
import type { IEmailConfig } from '../../models/Workspace.js';
import { recordEmailSendCost } from '../cost/tracker.js';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  unsubscribeUrl?: string;
  /** Required for Gmail token refresh + per-workspace cost attribution. */
  workspaceId?: string;
  /** Optional campaign attribution — when set, the cost event carries
   *  `campaignId` so the dashboard can report cost per campaign. */
  campaignId?: string;
}

export interface SendEmailResult {
  messageId: string;
}

function injectUnsubscribe(opts: SendEmailOptions): SendEmailOptions & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let { html, text } = opts;

  if (opts.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${opts.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';

    const footerHtml = `<br><br><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:11px;color:#999;font-family:sans-serif">You received this email because you are in our prospecting database. <a href="${opts.unsubscribeUrl}" style="color:#999">Unsubscribe</a></p>`;
    const footerText = `\n\n---\nTo unsubscribe: ${opts.unsubscribeUrl}`;

    html = html + footerHtml;
    if (text) text = text + footerText;
  }

  return { ...opts, html, text, headers };
}

export async function sendEmailForWorkspace(
  config: IEmailConfig & { apiKey?: string; smtpPass?: string },
  opts: SendEmailOptions,
): Promise<SendEmailResult> {
  const { headers, ...enrichedOpts } = injectUnsubscribe(opts);

  if (config.provider === 'resend') {
    if (!config.apiKey) throw new Error('Resend API key not configured for this workspace');
    const apiKey = decrypt(config.apiKey);
    const resend = new Resend(apiKey);
    const from = `${config.fromName} <${config.fromEmail}>`;
    const { data, error } = await resend.emails.send({
      from,
      to: enrichedOpts.to,
      subject: enrichedOpts.subject,
      html: enrichedOpts.html,
      text: enrichedOpts.text,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (error || !data) {
      logger.error('[emailService] Resend error', { error });
      throw new Error(error?.message ?? 'Resend: failed to send email');
    }
    if (opts.workspaceId) {
      void recordEmailSendCost('resend', {
        workspaceId: opts.workspaceId,
        campaignId: opts.campaignId,
        meta: { messageId: data.id, to: opts.to },
      });
    }
    return { messageId: data.id };
  }

  if (config.provider === 'sendgrid') {
    if (!config.apiKey) throw new Error('SendGrid API key not configured for this workspace');
    const apiKey = decrypt(config.apiKey);
    const transporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      auth: { user: 'apikey', pass: apiKey },
    });
    const info = await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: enrichedOpts.to,
      subject: enrichedOpts.subject,
      html: enrichedOpts.html,
      text: enrichedOpts.text,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (opts.workspaceId) {
      void recordEmailSendCost('sendgrid', {
        workspaceId: opts.workspaceId,
        campaignId: opts.campaignId,
        meta: { messageId: String(info.messageId), to: opts.to },
      });
    }
    return { messageId: String(info.messageId) };
  }

  if (config.provider === 'gmail') {
    const { sendViaGmail } = await import('../../controllers/gmail.controller.js');
    const gmailCfg = (config as unknown as { gmail?: { accessToken?: string; refreshToken?: string; expiresAt?: Date } }).gmail;
    if (!gmailCfg?.accessToken) throw new Error('Gmail not configured for this workspace');
    const messageId = await sendViaGmail(
      { accessToken: gmailCfg.accessToken, refreshToken: gmailCfg.refreshToken, expiresAt: gmailCfg.expiresAt },
      {
        workspaceId: opts.workspaceId ?? '',
        to: opts.to,
        subject: opts.subject,
        html: enrichedOpts.html,
        fromEmail: config.fromEmail,
        fromName: config.fromName,
        replyTo: config.replyTo,
      },
    );
    if (opts.workspaceId) {
      void recordEmailSendCost('gmail', {
        workspaceId: opts.workspaceId,
        campaignId: opts.campaignId,
        meta: { messageId, to: opts.to },
      });
    }
    return { messageId };
  }

  if (config.provider === 'smtp') {
    if (!config.smtpHost) throw new Error('SMTP host not configured for this workspace');
    const pass = config.smtpPass ? decrypt(config.smtpPass) : undefined;
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort ?? 587,
      secure: config.smtpSecure ?? false,
      auth: config.smtpUser ? { user: config.smtpUser, pass } : undefined,
    });
    const info = await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: enrichedOpts.to,
      subject: enrichedOpts.subject,
      html: enrichedOpts.html,
      text: enrichedOpts.text,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (opts.workspaceId) {
      void recordEmailSendCost('smtp', {
        workspaceId: opts.workspaceId,
        campaignId: opts.campaignId,
        meta: { messageId: String(info.messageId), to: opts.to },
      });
    }
    return { messageId: String(info.messageId) };
  }

  throw new Error(`Unsupported email provider: ${String(config.provider)}`);
}

// Converts plain-text body to minimal HTML, preserving line breaks (XSS-safe)
export function textToHtml(text: string): string {
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#333">${text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')}</div>`;
}
