import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { braveProvider } from './brave.js';
import { serpApiProvider } from './serpapi.js';
import { serperProvider } from './serper.js';
import { getQueryCache } from './queryCache.js';
import { recordSerpCost } from '../../services/costTracker.js';
import type { SearchEngine, SearchProvider, SearchResultItem } from './types.js';

/**
 * Central search router. Responsibilities:
 *  1. Cache lookup — serve identical queries from Redis without hitting any provider
 *  2. Provider selection — pick providers that support the requested engine AND
 *     aren't currently flagged as quota-exhausted
 *  3. Fail-over — on a provider error, try the next provider for that engine
 *  4. Write-through caching — successful results go into the cache with TTL
 *
 * SEARCH_PROVIDER_ORDER env var controls priority (e.g. "brave,serpapi").
 * Default: try the cheaper/more-available one first.
 *
 * Each provider may set `quotaExhausted: true` on its result; the router then
 * records that in-memory for the rest of the process lifetime (cleared on
 * worker restart). This prevents us from burning the budget re-hitting a
 * provider we already know is dry.
 */

const PROVIDERS: Record<string, SearchProvider> = {
  brave: braveProvider,
  serpapi: serpApiProvider,
  serper: serperProvider,
};

// Providers that have returned quotaExhausted this process. Cleared on restart.
const exhaustedProviders = new Set<string>();

function parseProviderOrder(): string[] {
  const raw = env.SEARCH_PROVIDER_ORDER.trim();
  if (!raw) return ['brave', 'serper', 'serpapi'];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Resolve the ordered list of providers to try for a given engine, filtering
 * out unconfigured and exhausted providers. May return an empty list if no
 * provider can serve the request — caller should treat that as "no results".
 */
function selectProviders(engine: SearchEngine): SearchProvider[] {
  const order = parseProviderOrder();
  const chosen: SearchProvider[] = [];
  for (const id of order) {
    const p = PROVIDERS[id];
    if (!p) continue;
    if (!p.isConfigured()) continue;
    if (exhaustedProviders.has(p.id)) continue;
    if (!p.supportsEngine(engine)) continue;
    chosen.push(p);
  }
  return chosen;
}

/**
 * Run a single query against one engine. Cached results win; otherwise
 * providers are tried in priority order until one returns OK.
 */
export async function routedSearch(query: string, engine: SearchEngine): Promise<SearchResultItem[]> {
  const cache = getQueryCache();
  const cached = await cache.get(engine, query);
  if (cached) return cached;

  const providers = selectProviders(engine);
  if (providers.length === 0) {
    logger.warn('[searchRouter] no provider available', { engine, query: query.slice(0, 60) });
    return [];
  }

  for (const provider of providers) {
    const result = await provider.search(query, engine);
    // Record cost for EVERY provider call we actually made — failed calls
    // still consumed quota (429s, empty responses, auth errors all burn credit).
    // Cache hits bypass this loop entirely, so we don't pay for them. Skipped
    // for providers flagged as free (Brave on current plan).
    void recordSerpCost(provider.id);

    if (result.quotaExhausted) {
      logger.warn('[searchRouter] provider exhausted for rest of process', { provider: provider.id });
      exhaustedProviders.add(provider.id);
    }
    if (result.ok && result.results.length > 0) {
      await cache.set(engine, query, result.results);
      return result.results;
    }
  }

  logger.warn('[searchRouter] all providers failed', {
    engine, query: query.slice(0, 60),
    tried: providers.map((p) => p.id),
  });
  return [];
}

/**
 * Legacy-compatible wrapper mirroring the old runSerpSearch signature. Accepts
 * multiple queries and an engine; returns a flat deduplicated list.
 */
export async function searchMany(
  queries: string[],
  engine: SearchEngine = 'google',
): Promise<SearchResultItem[]> {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const query of queries) {
    const batch = await routedSearch(query, engine);
    for (const r of batch) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
    }
  }
  return out;
}

/**
 * Legacy-compatible wrapper mirroring runMultiEngineSearch. Tries each
 * requested engine in order and merges; stops early once `sufficientCount`
 * is reached to save provider calls.
 */
export async function searchMultiEngine(
  queries: string[],
  opts: { engines?: SearchEngine[]; sufficientCount?: number } = {},
): Promise<SearchResultItem[]> {
  const engines = opts.engines ?? ['google', 'bing', 'duckduckgo'];
  const sufficient = opts.sufficientCount ?? 15;

  const merged = new Map<string, SearchResultItem>();
  for (const engine of engines) {
    const batch = await searchMany(queries, engine);
    for (const r of batch) {
      if (!merged.has(r.url)) merged.set(r.url, r);
    }
    if (merged.size >= sufficient) {
      logger.info('[searchRouter] sufficient results, stopping early', {
        stoppedAfter: engine, have: merged.size,
      });
      break;
    }
  }
  return [...merged.values()];
}

/**
 * Diagnostic helper — which providers are currently available for each engine.
 * Exported for the test harness and admin dashboard.
 */
export function getRouterStatus(): {
  order: string[];
  configured: string[];
  exhausted: string[];
  engines: Record<SearchEngine, string[]>;
} {
  const order = parseProviderOrder();
  const configured = order.filter((id) => PROVIDERS[id]?.isConfigured());
  const engines: Record<SearchEngine, string[]> = {
    google: selectProviders('google').map((p) => p.id),
    bing: selectProviders('bing').map((p) => p.id),
    duckduckgo: selectProviders('duckduckgo').map((p) => p.id),
    brave: selectProviders('brave').map((p) => p.id),
  };
  return { order, configured, exhausted: [...exhaustedProviders], engines };
}
