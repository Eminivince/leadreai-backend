import type { ToolDef } from './index.js';
import { registryLookup } from '../registryProviders/router.js';

/**
 * `list_companies` — get a list of known companies matching a (country,
 * industry [, tags]) query. Unlike `lookup_registry` (which resolves a
 * single named company to registered entity data), this tool is for
 * DISCOVERY: "give me Nigerian manufacturers", "list Nigerian fintechs".
 *
 * Registry sources are:
 *  - Curated seed JSONs (high-trust, domains included, supports "mid-tier"
 *    vs "blue-chip" filtering for exclusion-constrained queries)
 *  - Wikipedia category members (broad, deterministic, no quota)
 *
 * This tool is the preferred entry point for named-entity-list and
 * demographic-filter queries — it eliminates the "which search query do I
 * run to find Nigerian fintechs?" meta-problem that burns SERP budget.
 */
export const listCompaniesTool: ToolDef = {
  name: 'list_companies',
  description:
    'List known companies matching a (country, industry) query. Returns an array of {name, domain?, tags?, sourceUrl} — domains are high-confidence when present. Use this BEFORE search_web for any discovery query; filter by tags (e.g. ["mid-tier"], ["startup"]) to respect exclusion constraints in the original user query.',
  parametersSchema:
    '{"country": string (ISO-3166-1 alpha-2 like "NG","KE","GH"), "industry": string (e.g. "fintech","legal","manufacturing"), "tags"?: string[] (e.g. ["mid-tier"] to exclude blue-chip), "limit"?: number (default 50)}',
  handler: async (args) => {
    const country = String(args?.country ?? '').trim();
    const industry = args?.industry ? String(args.industry).trim() : undefined;
    const tagsArg = Array.isArray(args?.tags) ? args.tags.map((t: unknown) => String(t)) : undefined;
    const limit = Number.isFinite(Number(args?.limit)) ? Math.min(200, Math.max(1, Number(args.limit))) : 50;

    if (!country) return { ok: false, output: 'country is required (e.g. "NG")' };

    const { companies, providersUsed } = await registryLookup({
      country,
      ...(industry && { industry }),
      ...(tagsArg && { tags: tagsArg }),
      limit,
    });

    // Compact shape fed back to the LLM — minimal fields, high info-density.
    const compact = companies.map((c) => ({
      name: c.name,
      ...(c.domain && { domain: c.domain }),
      ...(c.tags && c.tags.length > 0 && { tags: c.tags }),
      ...(c.sourceUrl && { source: c.sourceUrl }),
    }));

    return {
      ok: true,
      output: JSON.stringify({
        found: companies.length,
        providersUsed,
        companies: compact,
      }),
      meta: { count: companies.length, providersUsed },
    };
  },
};
