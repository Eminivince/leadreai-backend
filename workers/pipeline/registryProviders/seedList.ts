import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import type { CompanyRegistry, RegistryCompany, RegistryLookupQuery } from './types.js';

/**
 * Seed-list registry provider. Reads curated JSON files from
 * `workers/src/data/seeds/` at startup; each file is a country+industry
 * collection of known companies (name + domain + tags).
 *
 * Why curated seeds are important:
 *   - Wikipedia coverage is patchy — fintechs especially underrepresented
 *   - SERP top-N lists are biased toward blue-chip
 *   - Users writing "outside blue-chip" queries need the engine to *know*
 *     which companies are blue-chip and which aren't
 *
 * Editorial discipline: only add companies we can point at a source for
 * (homepage, press coverage, previous successful harness run). Every tag is
 * a promise the agent can filter on, so accuracy matters more than coverage.
 *
 * Adding a new vertical is a 1-file change — drop `ng-saas.json` into the
 * seeds directory with the same shape, rebuild, ship.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = resolve(__dirname, '..', '..', 'data', 'seeds');

interface SeedFile {
  country: string;
  industry: string;
  description?: string;
  companies: Array<{
    name: string;
    domain?: string;
    description?: string;
    tags?: string[];
  }>;
}

interface SeedEntry extends RegistryCompany {
  // Pre-indexed tags for fast `includes` checks below.
  normalizedTags: Set<string>;
}

let _loaded: SeedEntry[] | null = null;

function loadAll(): SeedEntry[] {
  if (_loaded !== null) return _loaded;
  const out: SeedEntry[] = [];
  if (!existsSync(SEEDS_DIR)) {
    logger.warn('[seedList] seeds dir missing', { path: SEEDS_DIR });
    _loaded = out;
    return out;
  }
  const files = readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(SEEDS_DIR, file), 'utf8')) as SeedFile;
      for (const c of parsed.companies) {
        const tags = c.tags ?? [];
        out.push({
          name: c.name,
          ...(c.domain && { domain: c.domain }),
          ...(c.description && { description: c.description }),
          sourceUrl: `seed:${file}`,
          industry: parsed.industry,
          tags,
          providerId: 'seedList',
          normalizedTags: new Set([
            ...tags.map((t) => t.toLowerCase()),
            parsed.country.toUpperCase(),
            parsed.industry.toLowerCase(),
          ]),
        });
      }
      logger.info('[seedList] loaded', {
        file, country: parsed.country, industry: parsed.industry, count: parsed.companies.length,
      });
    } catch (err) {
      logger.warn('[seedList] parse failed', { file, err: err instanceof Error ? err.message : String(err) });
    }
  }
  _loaded = out;
  return out;
}

function industryMatches(entryIndustry: string, queryIndustry?: string): boolean {
  if (!queryIndustry) return true;
  const q = queryIndustry.toLowerCase();
  const e = entryIndustry.toLowerCase();
  if (e === q) return true;
  // Lightweight synonym handling — matches the same logic as the Wikipedia
  // provider's industryToken so users get consistent behavior across providers.
  if (/fintech|payment|financ/.test(q) && /fintech|financial|payment/.test(e)) return true;
  if (/law|legal/.test(q) && /law|legal/.test(e)) return true;
  if (/manufactur/.test(q) && /manufactur/.test(e)) return true;
  return false;
}

export const seedListRegistry: CompanyRegistry = {
  id: 'seedList',

  isConfigured(): boolean {
    return loadAll().length > 0;
  },

  supports(query: RegistryLookupQuery): boolean {
    const all = loadAll();
    return all.some(
      (e) =>
        e.normalizedTags.has(query.country.toUpperCase()) &&
        industryMatches(e.industry ?? '', query.industry),
    );
  },

  async lookup(query: RegistryLookupQuery): Promise<RegistryCompany[]> {
    const all = loadAll();
    const country = query.country.toUpperCase();
    const tags = (query.tags ?? []).map((t) => t.toLowerCase());
    const limit = query.limit ?? 100;

    const matched = all.filter((e) => {
      if (!e.normalizedTags.has(country)) return false;
      if (!industryMatches(e.industry ?? '', query.industry)) return false;
      if (tags.length > 0 && !tags.some((t) => e.normalizedTags.has(t))) return false;
      return true;
    });

    logger.info('[seedList] lookup', {
      country: query.country, industry: query.industry, tags, found: matched.length,
    });
    return matched.slice(0, limit).map(({ normalizedTags: _n, ...c }) => c);
  },
};
