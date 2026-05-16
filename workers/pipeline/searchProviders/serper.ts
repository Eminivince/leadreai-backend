import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { isFilePath, type SearchEngine, type SearchProvider, type SearchProviderResult } from './types.js';

/**
 * Serper.dev — SerpAPI-equivalent at roughly half the price. 2500 free queries
 * lifetime to test, then $50/mo for 50k queries. Returns Google SERP results
 * in a SerpAPI-like shape.
 *
 * Docs: https://serper.dev/docs
 *
 * Added primarily for cost reasons: if SerpAPI quota is exhausted, Serper is
 * an identical-quality Google fallback. Not a substitute for Brave (which has
 * an independent index), but a reasonable peer to SerpAPI.
 */

const SERPER_BASE = 'https://google.serper.dev/search';
const TIMEOUT_MS = 15_000;

interface SerperOrganicResult {
  link?: string;
  title?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
}

export const serperProvider: SearchProvider = {
  id: 'serper',

  isConfigured(): boolean {
    return !!env.SERPER_API_KEY;
  },

  // Serper hits Google under the hood — we expose it as a google substitute.
  supportsEngine(engine: SearchEngine): boolean {
    return engine === 'google';
  },

  async search(query: string, engine: SearchEngine): Promise<SearchProviderResult> {
    if (!env.SERPER_API_KEY) return { ok: false, status: 0, results: [] };
    if (!this.supportsEngine(engine)) return { ok: false, status: 0, results: [] };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(SERPER_BASE, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'X-API-KEY': env.SERPER_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: 10 }),
      });
      if (!res.ok) {
        const quotaExhausted = res.status === 429 || res.status === 403;
        logger.warn('[serper] non-200', { status: res.status, quotaExhausted });
        return { ok: false, status: res.status, results: [], quotaExhausted };
      }
      const data = await res.json() as SerperResponse;
      const organic = data.organic ?? [];
      const results = organic
        .filter((r): r is SerperOrganicResult & { link: string } => !!r.link)
        .map((r) => ({
          url: r.link,
          title: r.title ?? '',
          snippet: r.snippet ?? '',
          isFilePath: isFilePath(r.link),
          engine: 'google' as SearchEngine,
          providerId: 'serper',
        }));
      return { ok: true, status: 200, results };
    } catch (err) {
      logger.warn('[serper] fetch failed', { err: err instanceof Error ? err.message : String(err) });
      return { ok: false, status: 0, results: [] };
    } finally {
      clearTimeout(timeout);
    }
  },
};
