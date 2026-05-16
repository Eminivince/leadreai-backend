/**
 * Search-provider abstraction. Every provider (SerpAPI, Brave, Serper, etc.)
 * implements `SearchProvider` and the router picks one based on availability,
 * priority, and quota headroom.
 *
 * Contract is narrow so a new provider is ~50 lines of code:
 *  - `id` — stable name for telemetry and config
 *  - `isConfigured()` — checks env, used by the router to skip unconfigured providers
 *  - `search(query, engine?)` — runs a query, returns normalized results
 *  - `supportsEngine(engine)` — some providers are engine-specific (Brave is its
 *    own engine; SerpAPI speaks google/bing/ddg)
 */

export type SearchEngine = 'google' | 'bing' | 'duckduckgo' | 'brave';

export interface SearchResultItem {
  url: string;
  title: string;
  snippet: string;
  isFilePath: boolean;
  engine: SearchEngine;
  providerId: string;
}

export interface SearchProviderResult {
  ok: boolean;
  /** HTTP-style status — 0 for non-HTTP failures (abort, timeout). */
  status: number;
  results: SearchResultItem[];
  /** Set when the provider is hard-failing (e.g. daily quota exhausted).
   *  The router uses this to skip this provider for the rest of the batch. */
  quotaExhausted?: boolean;
}

export interface SearchProvider {
  id: string;
  isConfigured(): boolean;
  supportsEngine(engine: SearchEngine): boolean;
  search(query: string, engine: SearchEngine): Promise<SearchProviderResult>;
}

const FILE_EXT_RE = /\.(pdf|docx?|xlsx?)(\?.*)?$/i;

export function isFilePath(url: string): boolean {
  return FILE_EXT_RE.test(url);
}
