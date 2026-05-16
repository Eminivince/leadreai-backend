/**
 * Company-registry abstraction. Unlike search providers (which hit public SERPs),
 * registry providers return *known-good* company entities — curated lists,
 * Wikipedia categories, government registries, etc.
 *
 * Why separate from search: registries answer "what companies exist in
 * <vertical> in <country>" more reliably than SERP does. SERP is stochastic
 * and biased toward blog-post top-10 lists; registries are structured. Using
 * a registry first drops SERP calls per job by ~10×.
 *
 * Contract is narrow:
 *  - `id` — stable name for telemetry
 *  - `isConfigured()` — env check
 *  - `lookup(query)` — return companies matching the structured query
 *  - `supports(query)` — whether this provider can serve the query at all
 */

export interface RegistryLookupQuery {
  /** ISO-3166-1 alpha-2 country code, e.g. "NG" */
  country: string;
  /** Normalized industry hint. Providers are liberal about matching — "fintech"
   *  should match "financial services", "payments", etc. */
  industry?: string;
  /** Free-text tags that may refine the lookup (e.g. "mid-tier", "b2b").
   *  Providers with structured seed lists can filter on these; others ignore. */
  tags?: string[];
  /** Max results to return. */
  limit?: number;
}

export interface RegistryCompany {
  /** Canonical company name. Never null — if a provider can't resolve a name,
   *  it shouldn't return the entry. */
  name: string;
  /** Likely domain if known. Agent uses this as a high-confidence seed to
   *  skip the "find the real domain" SERP loop. */
  domain?: string;
  /** Free-form description for agent context. */
  description?: string;
  /** Stable URL for provenance — Wikipedia page, gov listing, etc. */
  sourceUrl?: string;
  /** Self-reported industry from the provider. */
  industry?: string;
  /** Free-form tags (e.g. "blue-chip", "mid-tier", "startup"). */
  tags?: string[];
  /** Where the entry came from — lets the aggregator explain a result. */
  providerId: string;
}

export interface RegistryResult {
  companies: RegistryCompany[];
  /** Providers that were tried, in order. */
  providersUsed: string[];
}

export interface CompanyRegistry {
  id: string;
  isConfigured(): boolean;
  supports(query: RegistryLookupQuery): boolean;
  lookup(query: RegistryLookupQuery): Promise<RegistryCompany[]>;
}
