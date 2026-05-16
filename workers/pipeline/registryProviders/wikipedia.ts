import { logger } from '../../utils/logger.js';
import type { CompanyRegistry, RegistryCompany, RegistryLookupQuery } from './types.js';

/**
 * Wikipedia (MediaWiki API) registry provider.
 *
 * Strategy: map (country, industry) onto a well-known Category: title, then
 * fetch members via the MediaWiki `categorymembers` action. Extract page
 * titles as company names. Optionally follow up with per-article metadata
 * lookups to get the company's homepage URL from infobox fields.
 *
 * Advantages over SERP for discovery:
 *  - Deterministic — same input, same output
 *  - Curated by editors, not ranked by algorithms
 *  - No rate limits for reasonable usage
 *  - Includes long-tail/mid-tier entries SERP top-10 misses
 *
 * Limits:
 *  - Coverage varies sharply by vertical/country (NG fintech thin, NG banks thick)
 *  - No structured industry metadata — we rely on category naming
 *  - Article titles sometimes differ from brand names (e.g. "Guaranty Trust Bank" not "GTBank")
 */

const MEDIAWIKI_API = 'https://en.wikipedia.org/w/api.php';
const TIMEOUT_MS = 12_000;

/**
 * Known category titles we expect to find on en.wikipedia, keyed by
 * `${COUNTRY}:${INDUSTRY_TOKEN}`. The provider tries each title in order until
 * one returns results. Adding a new vertical is a 1-line change here.
 */
const CATEGORY_MAP: Record<string, string[]> = {
  'NG:financial': [
    'Category:Financial_services_companies_of_Nigeria',
    'Category:Banks_of_Nigeria',
  ],
  'NG:fintech': [
    'Category:Financial_services_companies_of_Nigeria',
    'Category:Payment_service_providers',
  ],
  'NG:banking': [
    'Category:Banks_of_Nigeria',
    'Category:Financial_services_companies_of_Nigeria',
  ],
  'NG:legal': [
    'Category:Law_firms_of_Nigeria',
  ],
  'NG:law': [
    'Category:Law_firms_of_Nigeria',
  ],
  'NG:manufacturing': [
    'Category:Manufacturing_companies_of_Nigeria',
    'Category:Cement_companies_of_Nigeria',
    'Category:Drink_companies_of_Nigeria',
    'Category:Vehicle_manufacturers_of_Nigeria',
  ],
  'NG:telecommunications': ['Category:Telecommunications_companies_of_Nigeria'],
  'NG:oil': ['Category:Oil_and_gas_companies_of_Nigeria'],
  'NG:energy': ['Category:Oil_and_gas_companies_of_Nigeria'],
  'NG:food': ['Category:Food_companies_of_Nigeria'],
  'NG:media': ['Category:Mass_media_companies_of_Nigeria'],
  'NG:technology': [
    'Category:Companies_based_in_Lagos',
    'Category:Financial_services_companies_of_Nigeria',
  ],
  'NG:saas': [
    'Category:Companies_based_in_Lagos',
  ],
  // Kenya — initial set, expand as needed
  'KE:financial': ['Category:Financial_services_companies_of_Kenya'],
  'KE:telecommunications': ['Category:Telecommunications_companies_of_Kenya'],
  'KE:manufacturing': ['Category:Manufacturing_companies_of_Kenya'],
};

/** Normalize an industry string into the token used in CATEGORY_MAP. */
function industryToken(industry: string | undefined): string {
  if (!industry) return '';
  const s = industry.toLowerCase().trim();
  if (/fintech|payment/.test(s)) return 'fintech';
  if (/bank/.test(s)) return 'banking';
  if (/financ/.test(s)) return 'financial';
  if (/law|legal|firm/.test(s)) return 'legal';
  if (/manufactur|factor|plant|produc/.test(s)) return 'manufacturing';
  if (/telecom/.test(s)) return 'telecommunications';
  if (/oil|gas|petroleum|energy/.test(s)) return 'oil';
  if (/food|bever/.test(s)) return 'food';
  if (/media|broadcast|publish/.test(s)) return 'media';
  if (/saas|software|tech/.test(s)) return 'technology';
  return s;
}

interface WikiCategoryMember {
  ns: number;
  title: string;
}

interface WikiCategoryResponse {
  query?: { categorymembers?: WikiCategoryMember[] };
}

async function fetchCategoryMembers(category: string, limit: number): Promise<string[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'categorymembers',
    cmtitle: category,
    format: 'json',
    cmlimit: String(Math.min(500, Math.max(10, limit))),
    cmtype: 'page', // exclude subcategories — we only want actual company pages
    origin: '*',
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MEDIAWIKI_API}?${params.toString()}`, { signal: controller.signal });
    if (!res.ok) {
      logger.warn('[wikipedia] non-200', { category, status: res.status });
      return [];
    }
    const data = await res.json() as WikiCategoryResponse;
    const members = data.query?.categorymembers ?? [];
    return members.map((m) => m.title);
  } catch (err) {
    logger.warn('[wikipedia] fetch failed', { category, err: err instanceof Error ? err.message : String(err) });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export const wikipediaRegistry: CompanyRegistry = {
  id: 'wikipedia',

  isConfigured(): boolean {
    return true; // no auth needed
  },

  supports(query: RegistryLookupQuery): boolean {
    const key = `${query.country.toUpperCase()}:${industryToken(query.industry)}`;
    return key in CATEGORY_MAP;
  },

  async lookup(query: RegistryLookupQuery): Promise<RegistryCompany[]> {
    const key = `${query.country.toUpperCase()}:${industryToken(query.industry)}`;
    const categories = CATEGORY_MAP[key];
    if (!categories) return [];
    const limit = query.limit ?? 100;

    const seen = new Set<string>();
    const companies: RegistryCompany[] = [];
    for (const cat of categories) {
      const titles = await fetchCategoryMembers(cat, limit);
      for (const title of titles) {
        // Skip subcategory-like or meta pages that occasionally slip through.
        if (title.startsWith('Category:') || title.startsWith('List of')) continue;
        if (seen.has(title)) continue;
        seen.add(title);
        companies.push({
          name: title,
          sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
          industry: query.industry,
          providerId: 'wikipedia',
        });
        if (companies.length >= limit) break;
      }
      if (companies.length >= limit) break;
    }

    logger.info('[wikipedia] lookup', {
      country: query.country, industry: query.industry, found: companies.length,
      categoriesTried: categories.length,
    });
    return companies;
  },
};
