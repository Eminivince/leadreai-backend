import { z } from 'zod';
import { registerWorkerDataSource } from '../registry.js';
import { searchMultiEngine } from '../../../pipeline/searchProviders/router.js';
import type { SearchEngine } from '../../../pipeline/searchProviders/types.js';

/**
 * search_web as a first-class DataSource.
 *
 * This is the worked example for Phase 15A: one existing agent tool
 * re-registered in the new shape. The agent's direct tool (tools/searchWeb.ts)
 * still works; the DataSource wrapper gives the executor/invocation-log
 * pipeline a live source to exercise.
 *
 * Downstream of 15A, the agent's tool menu becomes a thin shim that
 * calls runWorkerDataSource('search_web', ...). For now both paths
 * coexist so we don't risk the agent loop on a refactor.
 */

const inputSchema = z.object({
  query: z.string().min(1).max(500),
  engine: z.enum(['google', 'bing', 'duckduckgo', 'brave']).optional(),
  maxResults: z.number().int().min(1).max(30).optional(),
});

const outputSchema = z.object({
  results: z.array(z.object({
    url: z.string(),
    title: z.string(),
    snippet: z.string(),
    providerId: z.string(),
    engine: z.string(),
  })),
  totalFound: z.number().int().nonnegative(),
});

registerWorkerDataSource({
  id: 'search_web',
  name: 'Web Search',
  description:
    'Multi-provider web search. Routes through Brave / Serper / SerpAPI with transparent fallback; caches results for 24h.',
  category: 'search',
  version: 1,

  input: {
    schema: inputSchema,
    describe: [
      { key: 'query', label: 'Query', required: true, hint: 'Plain text or Google dork syntax.' },
      { key: 'engine', label: 'Engine', required: false, hint: 'google | bing | duckduckgo | brave. Default: google.' },
      { key: 'maxResults', label: 'Max results', required: false, hint: '1–30. Default: 15.' },
    ],
  },

  output: {
    schema: outputSchema,
    describe: [
      { key: 'results[].url', label: 'URL', type: 'string' },
      { key: 'results[].title', label: 'Title', type: 'string' },
      { key: 'results[].snippet', label: 'Snippet', type: 'string' },
      { key: 'results[].providerId', label: 'Provider', type: 'string' },
      { key: 'totalFound', label: 'Total found', type: 'number' },
    ],
  },

  handler: async (input) => {
    const engines: SearchEngine[] = input.engine ? [input.engine as SearchEngine] : ['google', 'bing', 'duckduckgo'];
    const sufficient = input.maxResults ?? 15;
    const results = await searchMultiEngine([input.query], { engines, sufficientCount: sufficient });
    const trimmed = results.slice(0, sufficient);
    return {
      results: trimmed.map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        providerId: r.providerId,
        engine: String(r.engine),
      })),
      totalFound: results.length,
    };
  },
});
