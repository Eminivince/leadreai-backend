/**
 * Public SERP interface — now a thin adapter over the provider router.
 *
 * The original implementation called SerpAPI directly. All logic has moved to
 * `./searchProviders/router.ts` which supports multiple providers (Brave,
 * SerpAPI, future Serper/Tavily/etc.), per-query caching, and automatic
 * fail-over.
 *
 * Signatures are preserved so existing callers (searchWeb tool, researchAgent,
 * jobAgent) don't need to change.
 */

import { logger } from '../utils/logger.js';
import { searchMany, searchMultiEngine, getRouterStatus } from './searchProviders/router.js';
import type { SearchEngine, SearchResultItem } from './searchProviders/types.js';

/** Backward-compatible type alias for the old `SerpResult` shape. */
export interface SerpResult {
  url: string;
  title: string;
  snippet: string;
  isFilePath: boolean;
  engine?: 'google' | 'bing' | 'duckduckgo';
}

export type SerpEngine = 'google' | 'bing' | 'duckduckgo';

/**
 * Adapter: router returns `engine: 'brave'` too, but legacy callers expect only
 * google/bing/ddg. Map Brave results to `engine: undefined` so callers that
 * switch on engine don't break. Legacy engine names pass through unchanged.
 */
function adaptToLegacy(items: SearchResultItem[]): SerpResult[] {
  return items.map((r) => {
    const legacyEngine = r.engine === 'brave' ? undefined : (r.engine as SerpEngine);
    return {
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      isFilePath: r.isFilePath,
      ...(legacyEngine !== undefined && { engine: legacyEngine }),
    };
  });
}

export async function runSerpSearch(queries: string[], engine: SerpEngine = 'google'): Promise<SerpResult[]> {
  const items = await searchMany(queries, engine as SearchEngine);
  logger.info('SerpAPI search complete', { queries: queries.length, results: items.length, engine });
  return adaptToLegacy(items);
}

export async function runMultiEngineSearch(
  queries: string[],
  opts: { engines?: SerpEngine[]; sufficientCount?: number } = {},
): Promise<SerpResult[]> {
  const items = await searchMultiEngine(queries, {
    engines: opts.engines as SearchEngine[] | undefined,
    ...(opts.sufficientCount !== undefined && { sufficientCount: opts.sufficientCount }),
  });
  logger.info('[serpScraper] multi-engine complete', {
    enginesUsed: new Set(items.map((r) => r.engine)).size,
    totalResults: items.length,
  });
  return adaptToLegacy(items);
}

// Re-exported for admin/debug tooling — lets us answer "which provider is
// serving searches right now?" without reaching into the router module.
export { getRouterStatus };
