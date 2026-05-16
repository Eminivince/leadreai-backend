import { createHash, randomBytes } from 'crypto';
import MagicLinkToken from '../models/MagicLinkToken.js';
import { sendSystemEmail, escapeHtml } from './email/systemEmail.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const TOKEN_BYTES = 32; // 256 bits → 43 base64url chars
const TOKEN_TTL_MS = 15 * 60 * 1000;
const REQUEST_COOLDOWN_MS = 30 * 1000; // per-email throttle

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function frontendUrl(path: string): string {
  return `${env.FRONTEND_URL.replace(/\/$/, '')}${path}`;
}

export interface RequestMagicLinkInput {
  email: string;
  ip?: string;
}

export interface RequestMagicLinkResult {
  // 'sent' — email was queued; 'throttled' — a recent request exists
  // and we didn't send another one. Either way, the caller should not
  // leak the distinction to the user (same 200 response for both).
  status: 'sent' | 'throttled';
  devUrl?: string; // returned in dev mode (no RESEND_API_KEY) so the user can click through
}

export async function requestMagicLink(
  input: RequestMagicLinkInput,
): Promise<RequestMagicLinkResult> {
  const email = input.email.toLowerCase().trim();

  // Per-email cooldown. Prevents the "enter someone's email 50 times"
  // mailbomb. Reads the most recent token; if it's younger than the
  // cooldown and unused, treat as throttled.
  const recent = await MagicLinkToken.findOne({ email }).sort({ createdAt: -1 });
  if (recent && !recent.usedAt) {
    const age = Date.now() - recent.createdAt.getTime();
    if (age < REQUEST_COOLDOWN_MS) {
      return { status: 'throttled' };
    }
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await MagicLinkToken.create({
    email,
    tokenHash,
    expiresAt,
    requestIp: input.ip,
  });

  const link = frontendUrl(`/auth/magic?token=${encodeURIComponent(token)}`);

  const subject = 'Your LeadreAI sign-in link';
  const text = [
    `Sign in to LeadreAI by clicking the link below:`,
    ``,
    link,
    ``,
    `The link expires in 15 minutes and can only be used once.`,
    ``,
    `If you didn't ask for this, you can ignore this email — nothing will happen.`,
  ].join('\n');

  const safeLink = escapeHtml(link);
  const html = `
    <div style="font-family:Georgia,'Instrument Serif',serif;background:#F2EADD;padding:40px 20px;color:#15130F">
      <div style="max-width:520px;margin:0 auto;background:#F7F1E5;border:1px solid #B5AB95;padding:32px 32px 40px;">
        <div style="font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#8A8170">
          Sign in
        </div>
        <h1 style="font-family:Georgia,'Instrument Serif',serif;font-style:italic;font-size:32px;line-height:1.1;margin:8px 0 16px;color:#15130F">
          Your press pass <em style="color:#2D4634">has arrived</em>.
        </h1>
        <p style="font-family:system-ui,-apple-system,'Barlow',sans-serif;font-size:14px;line-height:1.55;color:#5A5346;margin:0 0 24px">
          Click the button below to sign in to your LeadreAI desk. The link is good for 15 minutes and can only be used once.
        </p>
        <p style="margin:0 0 24px">
          <a href="${safeLink}" style="display:inline-block;background:#15130F;color:#F2EADD;padding:12px 20px;border-radius:999px;font-family:system-ui,-apple-system,'Barlow',sans-serif;font-size:13px;font-weight:500;text-decoration:none">
            Sign in to LeadreAI →
          </a>
        </p>
        <p style="font-family:system-ui,-apple-system,'Barlow',sans-serif;font-size:12px;line-height:1.5;color:#8A8170;margin:0 0 8px">
          Or copy this link into your browser:
        </p>
        <p style="font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;color:#5A5346;margin:0 0 24px">
          ${safeLink}
        </p>
        <hr style="border:none;border-top:1px solid #B5AB95;margin:24px 0">
        <p style="font-family:system-ui,-apple-system,'Barlow',sans-serif;font-style:italic;font-size:12px;line-height:1.5;color:#8A8170;margin:0">
          If you didn't ask for this, you can ignore this email — nothing will happen.
        </p>
      </div>
      <div style="font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#8A8170;text-align:center;margin-top:20px">
        LeadreAI · The Editorial Desk
      </div>
    </div>
  `;

  const result = await sendSystemEmail({ to: email, subject, html, text });
  if (result.devLogged) {
    logger.info('[magicLink] dev link', { email, url: link });
    return { status: 'sent', devUrl: link };
  }
  return { status: 'sent' };
}

export interface VerifyMagicLinkResult {
  email: string;
}

/**
 * Consume a magic-link token. Atomic: the token is marked used in the
 * same findOneAndUpdate that validates it, so two parallel verify calls
 * with the same token can't both succeed.
 */
export async function verifyMagicLink(token: string): Promise<VerifyMagicLinkResult> {
  const tokenHash = hashToken(token);

  const consumed = await MagicLinkToken.findOneAndUpdate(
    {
      tokenHash,
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true },
  );

  if (!consumed) {
    throw new Error('Invalid, expired, or already-used token');
  }

  return { email: consumed.email };
}
