import { extractAggregatorName } from '../aggregatorNameExtractor.js';
import type { ToolDef } from './index.js';

export const extractNamesFromUrlsTool: ToolDef = {
  name: 'extract_names_from_urls',
  description: 'Given a list of URLs, extract person names embedded in aggregator profile paths (zoominfo, rocketreach, contactout, datanyze, linkedin). Free signal — no network calls.',
  parametersSchema: '{"urls": string[]}',
  handler: async (args) => {
    const urls: string[] = Array.isArray(args?.urls) ? args.urls : [];
    const names = urls
      .map(u => extractAggregatorName(u))
      .filter((n): n is NonNullable<typeof n> => n !== null);
    const deduped = new Map<string, typeof names[0]>();
    for (const n of names) {
      const key = n.fullName.toLowerCase();
      if (!deduped.has(key)) deduped.set(key, n);
    }
    return {
      ok: true,
      output: JSON.stringify([...deduped.values()]),
      meta: { count: deduped.size },
    };
  },
};
