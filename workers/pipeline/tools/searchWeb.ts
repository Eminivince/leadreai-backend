import { runSerpSearch, runMultiEngineSearch } from '../serpScraper.js';
import type { ToolDef } from './index.js';
import { logger } from '../../utils/logger.js';

export interface WebResult {
  url: string;
  title: string;
  snippet: string;
}

export async function searchWeb(query: string, site?: string, limit = 5): Promise<WebResult[]> {
  const fullQuery = site ? `${query} site:${site}` : query;
  try {
    const results = await runSerpSearch([fullQuery]);
    return results.slice(0, limit).map(r => ({ url: r.url, title: r.title, snippet: r.snippet }));
  } catch (err) {
    logger.warn('[searchWeb] failed', { query: fullQuery, err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export const searchWebTool: ToolDef = {
  name: 'search_web',
  description: 'Run a web search. Use site:X restriction to target a specific domain. Returns up to 8 url/title/snippet triples.',
  parametersSchema: '{"query": string, "site"?: string, "engines"?: ("google"|"bing"|"duckduckgo")[]}',
  handler: async (args) => {
    const q = String(args?.query ?? '').trim();
    if (!q) return { ok: false, output: 'query required' };
    const site = args?.site ? String(args.site) : undefined;
    const engines = Array.isArray(args?.engines) ? args.engines : undefined;
    const fullQ = site ? `${q} site:${site}` : q;
    const results = engines
      ? await runMultiEngineSearch([fullQ], { engines, sufficientCount: 8 })
      : await runSerpSearch([fullQ]);
    const compact = results.slice(0, 8).map(r => ({ url: r.url, title: r.title, snippet: r.snippet }));
    return { ok: true, output: JSON.stringify(compact), meta: { count: compact.length } };
  },
};
