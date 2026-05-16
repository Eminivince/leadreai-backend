import { logger } from '../../utils/logger.js';
import { seedListRegistry } from './seedList.js';
import { wikipediaRegistry } from './wikipedia.js';
import type { CompanyRegistry, RegistryCompany, RegistryLookupQuery, RegistryResult } from './types.js';

/**
 * Registry router. Unlike the search router (which picks ONE provider per
 * query), the registry router fans out across ALL configured + supporting
 * providers and merges results — seed lists have high-precision domains
 * Wikipedia lacks, Wikipedia has long-tail coverage seeds miss, and future
 * providers (CAC, Crunchbase, etc.) will add specific signals.
 *
 * Dedup is by lowercased company name. Provider order in the output reflects
 * the order of PROVIDERS below — seedList first (most trusted, has domains),
 * then Wikipedia. The `providerId` on each RegistryCompany tells callers
 * which source it came from.
 */

const PROVIDERS: CompanyRegistry[] = [
  seedListRegistry,
  wikipediaRegistry,
];

function keyOf(c: RegistryCompany): string {
  return c.name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Merge two records of the same company from different providers, keeping
 * the most informative fields. Seed list wins on `domain` (curated), but
 * Wikipedia wins on `sourceUrl` if the seed list's sourceUrl is just the
 * filename stub.
 */
function mergeCompany(a: RegistryCompany, b: RegistryCompany): RegistryCompany {
  const aIsSeed = a.providerId === 'seedList';
  const bIsSeed = b.providerId === 'seedList';

  const domain = a.domain ?? b.domain;
  const sourceUrl = aIsSeed && b.sourceUrl && !b.sourceUrl.startsWith('seed:')
    ? b.sourceUrl
    : bIsSeed && a.sourceUrl && !a.sourceUrl.startsWith('seed:')
      ? a.sourceUrl
      : a.sourceUrl ?? b.sourceUrl;

  const tags = new Set<string>([...(a.tags ?? []), ...(b.tags ?? [])]);
  const providerId = aIsSeed || bIsSeed ? 'seedList+wikipedia' : a.providerId;

  return {
    name: a.name,
    ...(domain && { domain }),
    ...(a.description || b.description ? { description: a.description ?? b.description } : {}),
    ...(sourceUrl && { sourceUrl }),
    ...(a.industry && { industry: a.industry }),
    ...(tags.size > 0 && { tags: [...tags] }),
    providerId,
  };
}

export async function registryLookup(query: RegistryLookupQuery): Promise<RegistryResult> {
  const limit = query.limit ?? 50;
  const providersUsed: string[] = [];
  const merged = new Map<string, RegistryCompany>();

  for (const p of PROVIDERS) {
    if (!p.isConfigured()) continue;
    if (!p.supports(query)) continue;

    try {
      const results = await p.lookup({ ...query, limit });
      providersUsed.push(p.id);
      for (const r of results) {
        const k = keyOf(r);
        const existing = merged.get(k);
        if (existing) merged.set(k, mergeCompany(existing, r));
        else merged.set(k, r);
      }
    } catch (err) {
      logger.warn('[registryRouter] provider failed', {
        provider: p.id, err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const companies = [...merged.values()].slice(0, limit);
  logger.info('[registryRouter] lookup complete', {
    country: query.country, industry: query.industry, tags: query.tags,
    providersUsed, total: companies.length,
  });
  return { companies, providersUsed };
}

export function getRegistryStatus(): {
  providers: Array<{ id: string; configured: boolean }>;
} {
  return {
    providers: PROVIDERS.map((p) => ({ id: p.id, configured: p.isConfigured() })),
  };
}
