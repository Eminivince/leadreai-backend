import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { isFilePath, type SearchEngine, type SearchProvider, type SearchProviderResult } from './types.js';

const SERPAPI_BASE = 'https://serpapi.com/search.json';
const TIMEOUT_MS = 15_000;

interface SerpApiOrganic {
  link?: string;
  title?: string;
  snippet?: string;
}

export const serpApiProvider: SearchProvider = {
  id: 'serpapi',

  isConfigured(): boolean {
    return !!env.SERPAPI_KEY;
  },

  supportsEngine(engine: SearchEngine): boolean {
    return engine === 'google' || engine === 'bing' || engine === 'duckduckgo';
  },

  async search(query: string, engine: SearchEngine): Promise<SearchProviderResult> {
    if (!env.SERPAPI_KEY) return { ok: false, status: 0, results: [] };
    if (!this.supportsEngine(engine)) return { ok: false, status: 0, results: [] };

    const params = new URLSearchParams({
      engine,
      q: query,
      api_key: env.SERPAPI_KEY,
    });
    if (engine === 'google') { params.set('num', '10'); params.set('hl', 'en'); }
    else if (engine === 'bing') { params.set('count', '10'); }
    else if (engine === 'duckduckgo') { params.set('kl', 'us-en'); }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${SERPAPI_BASE}?${params.toString()}`, { signal: controller.signal });
      if (!res.ok) {
        // SerpAPI returns 429 when the monthly quota is exhausted; mark it so the
        // router skips this provider for the rest of the batch.
        const quotaExhausted = res.status === 429;
        logger.warn('[serpapi] non-200', { engine, status: res.status, quotaExhausted });
        return { ok: false, status: res.status, results: [], quotaExhausted };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as any;
      const organic = (data?.organic_results as SerpApiOrganic[] | undefined) ?? [];
      const results = organic
        .filter((r): r is SerpApiOrganic & { link: string } => !!r.link)
        .map((r) => ({
          url: r.link,
          title: r.title ?? '',
          snippet: r.snippet ?? '',
          isFilePath: isFilePath(r.link),
          engine,
          providerId: 'serpapi',
        }));
      return { ok: true, status: 200, results };
    } catch (err) {
      logger.warn('[serpapi] fetch failed', { engine, err: err instanceof Error ? err.message : String(err) });
      return { ok: false, status: 0, results: [] };
    } finally {
      clearTimeout(timeout);
    }
  },
};
