import { promises as dns } from 'dns';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { ToolDef } from './index.js';

export interface VerifyResult {
  address: string;
  hasMx: boolean;
  mxHost?: string;
  verdict: 'likely_valid' | 'likely_catch_all' | 'invalid_domain' | 'undeliverable' | 'risky' | 'unknown';
  provider: 'mx_only' | 'reacher';
  reasoning?: string;
}

const mxCache = new Map<string, { hasMx: boolean; mxHost?: string }>();
const REACHER_TIMEOUT_MS = 20_000;

async function verifyMxOnly(address: string): Promise<VerifyResult> {
  const addr = address.toLowerCase().trim();
  const parts = addr.split('@');
  if (parts.length !== 2 || !parts[1]) {
    return { address: addr, hasMx: false, verdict: 'invalid_domain', provider: 'mx_only' };
  }
  const domain = parts[1];

  const cached = mxCache.get(domain);
  if (cached) {
    return {
      address: addr, ...cached,
      verdict: cached.hasMx ? 'likely_valid' : 'invalid_domain',
      provider: 'mx_only',
    };
  }

  try {
    const records = await dns.resolveMx(domain);
    if (records.length === 0) {
      mxCache.set(domain, { hasMx: false });
      return { address: addr, hasMx: false, verdict: 'invalid_domain', provider: 'mx_only' };
    }
    const mxHost = records.sort((a, b) => a.priority - b.priority)[0]?.exchange;
    mxCache.set(domain, { hasMx: true, mxHost });
    return { address: addr, hasMx: true, mxHost, verdict: 'likely_valid', provider: 'mx_only' };
  } catch (err) {
    logger.debug('[verifyEmail:mx_only] MX lookup failed', {
      domain, err: err instanceof Error ? err.message : String(err),
    });
    mxCache.set(domain, { hasMx: false });
    return { address: addr, hasMx: false, verdict: 'unknown', provider: 'mx_only' };
  }
}

async function verifyReacher(address: string, reacherUrl: string): Promise<VerifyResult> {
  const addr = address.toLowerCase().trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REACHER_TIMEOUT_MS);
  try {
    const res = await fetch(`${reacherUrl.replace(/\/$/, '')}/v0/check_email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_email: addr }),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn('[verifyEmail:reacher] non-200, falling back to mx_only', { status: res.status });
      return verifyMxOnly(address);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    const reachable: string = data?.is_reachable ?? 'unknown';
    const mxAccepts: boolean = Boolean(data?.mx?.accepts_mail);
    const mxHost: string | undefined = data?.mx?.records?.[0];

    const verdictMap: Record<string, VerifyResult['verdict']> = {
      safe: 'likely_valid',
      risky: 'risky',
      invalid: 'undeliverable',
      unknown: 'unknown',
    };
    const verdict = verdictMap[reachable] ?? 'unknown';

    return {
      address: addr,
      hasMx: mxAccepts,
      mxHost,
      verdict,
      provider: 'reacher',
      reasoning: typeof data?.smtp?.description === 'string' ? data.smtp.description : undefined,
    };
  } catch (err) {
    logger.warn('[verifyEmail:reacher] request failed, falling back to mx_only', {
      err: err instanceof Error ? err.message : String(err),
    });
    return verifyMxOnly(address);
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyEmail(address: string): Promise<VerifyResult> {
  if (env.EMAIL_VERIFIER_PROVIDER === 'reacher' && env.REACHER_URL) {
    return verifyReacher(address, env.REACHER_URL);
  }
  return verifyMxOnly(address);
}

export const verifyEmailTool: ToolDef = {
  name: 'verify_email',
  description: 'Verify an email via MX lookup (+ SMTP probe if reacher.email is configured). Returns { hasMx, verdict }.',
  parametersSchema: '{"address": string}',
  handler: async (args) => {
    const address = String(args?.address ?? '').trim();
    if (!address.includes('@')) return { ok: false, output: 'valid email required' };
    const result = await verifyEmail(address);
    return { ok: true, output: JSON.stringify(result) };
  },
};
