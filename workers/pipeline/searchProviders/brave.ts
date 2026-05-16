import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { isFilePath, type SearchEngine, type SearchProvider, type SearchProviderResult } from './types.js';

/**
 * Brave Search API. Free tier is 2000 requests/month with a 1 req/sec rate
 * limit; paid tiers are priced ~3× cheaper than SerpAPI.
 *
 * Docs: https://api.search.brave.com/app/documentation/web-search/get-started
 *
 * Unlike SerpAPI (which wraps other engines' SERPs), Brave has its own
 * independent index. That's actually useful for us: when SerpAPI's Google
 * engine gets rate-limited, Brave's results come from a totally separate
 * source, not just a different UA hitting Google.
 */

const BRAVE_BASE = 'https://api.search.brave.com/res/v1/web/search';
const TIMEOUT_MS = 15_000;

interface BraveWebResult {
  url?: string;
  title?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

export const braveProvider: SearchProvider = {
  id: 'brave',

  isConfigured(): boolean {
    return !!env.BRAVE_SEARCH_API_KEY;
  },

  // Brave is its own engine — we expose it as `brave` and also serve any `google`
  // request, since it's a reasonable Google-tier substitute.
  supportsEngine(engine: SearchEngine): boolean {
    return engine === 'brave' || engine === 'google';
  },

  async search(query: string, engine: SearchEngine): Promise<SearchProviderResult> {
    if (!env.BRAVE_SEARCH_API_KEY) return { ok: false, status: 0, results: [] };
    if (!this.supportsEngine(engine)) return { ok: false, status: 0, results: [] };

    const params = new URLSearchParams({ q: query, count: '10' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BRAVE_BASE}?${params.toString()}`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY,
        },
      });
      if (!res.ok) {
        // Brave returns 429 on both rate-limit (recoverable) and monthly-quota
        // (unrecoverable within the day). We can't reliably tell them apart, so
        // we mark 429 as quotaExhausted and let the router skip Brave; the next
        // call 1+ hour later can re-enable it via a fresh configured check.
        const quotaExhausted = res.status === 429;
        logger.warn('[brave] non-200', { status: res.status, quotaExhausted });
        return { ok: false, status: res.status, results: [], quotaExhausted };
      }
      const data = await res.json() as BraveResponse;
      const raw = data.web?.results ?? [];
      const results = raw
        .filter((r): r is BraveWebResult & { url: string } => !!r.url)
        .map((r) => ({
          url: r.url,
          title: r.title ?? '',
          snippet: r.description ?? '',
          isFilePath: isFilePath(r.url),
          engine: 'brave' as SearchEngine,
          providerId: 'brave',
        }));
      return { ok: true, status: 200, results };
    } catch (err) {
      logger.warn('[brave] fetch failed', { err: err instanceof Error ? err.message : String(err) });
      return { ok: false, status: 0, results: [] };
    } finally {
      clearTimeout(timeout);
    }
  },
};
