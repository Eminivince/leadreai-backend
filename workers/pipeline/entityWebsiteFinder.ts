import { logger } from '../utils/logger.js';
import { runSerpSearch } from './serpScraper.js';
import type { SerpResult } from './serpScraper.js';
import type { ParsedIntent } from '../../shared/index.js';

const SKIP_DOMAINS = [
  // Social & generic aggregators
  'linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com',
  'wikipedia.org', 'youtube.com', 'bloomberg.com', 'reuters.com',
  'forbes.com', 'crunchbase.com', 'glassdoor.com',
  // Lead-database aggregators (paywalled, never the actual company website)
  'zoominfo.com', 'rocketreach.co', 'contactout.com', 'signalhire.com', 'datanyze.com',
  'apollo.io', 'hunter.io', 'lusha.com', 'clearbit.com', 'leadiq.com', 'snov.io',
  'seamless.ai', 'lead411.com', 'uplead.com', 'anymailfinder.com',
  // Job boards
  'myjobmag.com', 'jobberman.com', 'indeed.com', 'monster.com',
];

function isAggregator(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SKIP_DOMAINS.some(d => host.includes(d));
  } catch {
    return false;
  }
}

// For each entity, generate contact-page URL variants to try directly
function contactPageVariants(baseUrl: string): string[] {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    return [
      baseUrl,
      `${origin}/contact`,
      `${origin}/contact-us`,
      `${origin}/about`,
      `${origin}/about-us`,
      `${origin}/team`,
    ];
  } catch {
    return [baseUrl];
  }
}

/**
 * For each resolved entity name, run a targeted SerpAPI query to find the
 * firm's official website. Returns SerpResult[] pointing directly to those
 * sites (and their contact pages), ready to be scraped.
 *
 * Called only for named_entity_list / contact_lookup queries after entity
 * resolution has populated namedEntities.
 */
export async function findEntityWebsites(
  entityNames: string[],
  intent: ParsedIntent,
): Promise<SerpResult[]> {
  const country = (intent.geography.country ?? '').trim();
  const wantsPhone = intent.desiredFields.some(f => f === 'officePhone' || f === 'mobilePhone');

  const allResults: SerpResult[] = [];

  for (const name of entityNames.slice(0, 10)) {
    // Build a direct website-finding query for this specific entity
    const baseQuery = `"${name}" ${country ? `"${country}"` : ''} official website`.trim();
    const contactQuery = wantsPhone
      ? `"${name}" ${country} contact phone number`
      : `"${name}" ${country} contact email`;

    logger.debug('[entityWebsiteFinder] Searching for entity website', { name, baseQuery });

    const [websiteResults, contactResults] = await Promise.all([
      runSerpSearch([baseQuery]).catch(() => []),
      runSerpSearch([contactQuery]).catch(() => []),
    ]);

    const combined = [...websiteResults, ...contactResults];

    // Pick first non-aggregator result as the "official" site
    const officialResult = combined.find(r => !isAggregator(r.url));
    if (!officialResult) {
      logger.info('[entityWebsiteFinder] No official site found — all results were aggregators', {
        name, sampleUrls: combined.slice(0, 3).map(r => r.url),
      });
      continue;
    }

    // Add the landing page + contact subpage variants
    const variants = contactPageVariants(officialResult.url);
    for (const variantUrl of variants) {
      allResults.push({
        url: variantUrl,
        title: officialResult.title,
        snippet: officialResult.snippet,
        isFilePath: false,
      });
    }

    // Also include any direct contact results that aren't aggregators
    for (const r of contactResults.filter(r => !isAggregator(r.url)).slice(0, 2)) {
      allResults.push(r);
    }
  }

  logger.info('[entityWebsiteFinder] Done', {
    entityCount: entityNames.length,
    urlsFound: allResults.length,
  });

  return allResults;
}
