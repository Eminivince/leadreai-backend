import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Hunter.io Domain Search wrapper.
 *
 * Hunter is the primary email source for contact enrichment. It returns
 * named work-emails for a domain even when the company has no public team
 * page — which is the failure mode that drives ~50% of our prune rate
 * with web-scrape-only enrichment.
 *
 * Free tier: 25 domain searches / month. Paid tier starts at $49/mo for
 * 500 searches. The service degrades gracefully when HUNTER_API_KEY is
 * unset (returns []), so the rest of the pipeline keeps working.
 *
 * Docs: https://hunter.io/api-documentation/v2#domain-search
 */

const HUNTER_BASE = 'https://api.hunter.io/v2';
const REQUEST_TIMEOUT_MS = 15_000;

// In-process cache so retries within a single job (or back-to-back jobs
// against the same domain) don't burn through the monthly free-tier
// quota. Keyed by domain; entries expire after 24h to keep us within
// reasonable freshness for B2B data.
const cache = new Map<string, { fetchedAt: number; result: HunterDomainResult }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface HunterEmailHit {
  /** Email address — Hunter normalises case. */
  address: string;
  /** Hunter's confidence score, 0-100. We propagate as 0-1 for our schema. */
  confidence: number;
  /** "personal" (named individual) or "generic" (info@, contact@, support@). */
  emailType: 'personal' | 'generic';
  firstName?: string;
  lastName?: string;
  position?: string;
  department?: string;
  /** Hunter's own verifier verdict, when included. */
  verifierStatus?: 'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown';
}

export interface HunterDomainResult {
  domain: string;
  organization?: string;
  /** Pattern Hunter inferred from observed emails (e.g. "{first}.{last}"). */
  pattern?: string;
  emails: HunterEmailHit[];
}

export function isHunterConfigured(): boolean {
  return Boolean(env.HUNTER_API_KEY);
}

/**
 * Fetches named emails for a domain via Hunter Domain Search.
 *
 * Returns an empty result (never throws) on configuration miss, network
 * failure, rate limit, or unexpected response shape — the caller can
 * always fall back to web-scrape extraction.
 *
 * Default limit is 10 to match Hunter's free-plan ceiling. Paid plans
 * support up to 100; callers on paid plans can pass a higher limit.
 * If the API returns `pagination_error` (limit exceeds plan), we retry
 * once with limit=10 — the integration self-heals across plan tiers.
 */
export async function hunterDomainSearch(
  domain: string,
  opts: { limit?: number; type?: 'personal' | 'generic' } = {},
): Promise<HunterDomainResult> {
  const empty: HunterDomainResult = { domain, emails: [] };
  if (!env.HUNTER_API_KEY) return empty;

  // Hunter expects an apex/host domain (acme.com), not a URL or path
  const cleaned = domain.replace(/^https?:\/\//i, '').split('/')[0]?.toLowerCase();
  if (!cleaned) return empty;

  const cached = cache.get(cleaned);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  // Free plan caps at 10. Default to 10 so we don't 400 on every free-tier call.
  return runDomainSearch(cleaned, opts.limit ?? 10, opts.type, /* allowRetry */ true);
}

async function runDomainSearch(
  cleaned: string,
  limit: number,
  type: 'personal' | 'generic' | undefined,
  allowRetry: boolean,
): Promise<HunterDomainResult> {
  const empty: HunterDomainResult = { domain: cleaned, emails: [] };
  const params = new URLSearchParams({
    domain: cleaned,
    api_key: env.HUNTER_API_KEY!,
    limit: String(limit),
  });
  if (type) params.set('type', type);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${HUNTER_BASE}/domain-search?${params.toString()}`, {
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      logger.warn('[hunter] auth failed — check HUNTER_API_KEY', { status: res.status });
      return empty;
    }
    if (res.status === 429) {
      logger.warn('[hunter] rate limited / quota exhausted', { domain: cleaned });
      // Cache empty result briefly so we don't hammer Hunter for the rest of
      // the job. Quota resets monthly; a single job shouldn't keep retrying.
      cache.set(cleaned, { fetchedAt: Date.now(), result: empty });
      return empty;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Free plan rejects limit > 10 with pagination_error. Retry once with limit=10.
      if (res.status === 400 && body.includes('pagination_error') && allowRetry && limit > 10) {
        logger.info('[hunter] plan limit hit — retrying with limit=10', { domain: cleaned });
        return runDomainSearch(cleaned, 10, type, /* allowRetry */ false);
      }
      logger.warn('[hunter] non-200 response', { status: res.status, body: body.slice(0, 200) });
      return empty;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any;
    const data = json?.data;
    if (!data || !Array.isArray(data.emails)) {
      logger.warn('[hunter] unexpected response shape', { domain: cleaned });
      return empty;
    }

    const result: HunterDomainResult = {
      domain: cleaned,
      organization: typeof data.organization === 'string' ? data.organization : undefined,
      pattern: typeof data.pattern === 'string' ? data.pattern : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emails: (data.emails as any[])
        .map((e): HunterEmailHit | null => {
          const address = typeof e?.value === 'string' ? e.value.toLowerCase().trim() : '';
          if (!address.includes('@')) return null;
          const rawType = e?.type;
          const emailType: 'personal' | 'generic' =
            rawType === 'personal' ? 'personal' : 'generic';
          return {
            address,
            confidence: typeof e?.confidence === 'number' ? e.confidence : 0,
            emailType,
            firstName: typeof e?.first_name === 'string' ? e.first_name : undefined,
            lastName: typeof e?.last_name === 'string' ? e.last_name : undefined,
            position: typeof e?.position === 'string' ? e.position : undefined,
            department: typeof e?.department === 'string' ? e.department : undefined,
            verifierStatus: typeof e?.verification?.status === 'string'
              ? e.verification.status
              : undefined,
          };
        })
        .filter((x): x is HunterEmailHit => x !== null),
    };

    cache.set(cleaned, { fetchedAt: Date.now(), result });
    logger.info('[hunter] domain-search hit', {
      domain: cleaned,
      count: result.emails.length,
      org: result.organization,
    });
    return result;
  } catch (err) {
    logger.warn('[hunter] request failed', {
      domain: cleaned,
      err: err instanceof Error ? err.message : String(err),
    });
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}
