import { Resend } from 'resend';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

/* ─────────────────────────────────────────────────────────────────
 * System-level transactional email — auth emails (magic link,
 * verification, password reset), billing receipts, etc.
 *
 * Unlike the per-workspace outreach config (which uses the
 * workspace's own provider + from-address), system emails all
 * share the RESEND_API_KEY + SYSTEM_FROM_EMAIL envs. This is
 * "hello@yoursaas.com" territory — a single from-address for the
 * whole product.
 *
 * Dev mode behavior: when RESEND_API_KEY is not set, we log the
 * email to the console and return a fake messageId. This keeps
 * local dev frictionless; production still fails hard if you
 * forgot to configure Resend.
 * ───────────────────────────────────────────────────────────────── */

let _resend: Resend | null = null;
function resend(): Resend {
  if (!_resend) {
    if (!env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not configured');
    }
    _resend = new Resend(env.RESEND_API_KEY);
  }
  return _resend;
}

export interface SystemEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface SystemEmailResult {
  messageId: string;
  devLogged?: boolean;
}

export async function sendSystemEmail(opts: SystemEmailOptions): Promise<SystemEmailResult> {
  const from = `${env.SYSTEM_FROM_NAME} <${env.SYSTEM_FROM_EMAIL}>`;

  if (!env.RESEND_API_KEY) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'Cannot send system email in production without RESEND_API_KEY configured.',
      );
    }
    logger.warn(
      '[systemEmail] RESEND_API_KEY not set — logging email to console instead of sending',
      {
        from,
        to: opts.to,
        subject: opts.subject,
        preview: opts.text?.slice(0, 280) ?? opts.html.slice(0, 280),
      },
    );
    return { messageId: 'dev-logged', devLogged: true };
  }

  const { data, error } = await resend().emails.send({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
  });

  if (error || !data) {
    logger.error('[systemEmail] Resend error', { error, to: opts.to });
    throw new Error(error?.message ?? 'Failed to send system email');
  }

  return { messageId: data.id };
}

/** Escape untrusted values for interpolation into HTML attributes/text. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
