import type { SerpResult } from './serpScraper.js';
import type { ParsedIntent } from '../../shared/index.js';

// Domains that are aggregators/directories, never direct company pages
const SKIP_DOMAIN_FRAGMENTS = [
  // Social & generic aggregators
  'wikipedia.org', 'linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com',
  'youtube.com', 'yelp.com', 'yellowpages', 'tripadvisor', 'glassdoor', 'indeed.com',
  'crunchbase.com', 'bloomberg.com', 'reuters.com', 'forbes.com', 'statista.com',
  'quora.com', 'reddit.com', 'trustpilot', 'clutch.co', 'g2.com', 'capterra.com',
  // Lead-database aggregators — they paywall their data and scraping produces junk
  'zoominfo.com', 'rocketreach.co', 'contactout.com', 'signalhire.com', 'datanyze.com',
  'apollo.io', 'hunter.io', 'lusha.com', 'clearbit.com', 'leadiq.com', 'snov.io',
  'seamless.ai', 'lead411.com', 'uplead.com', 'prospect.io', 'anymailfinder.com',
  // Job boards (useful for jobs, but not for finding a specific company's contacts)
  'myjobmag.com', 'jobberman.com', 'indeed.com', 'monster.com', 'ziprecruiter.com',
  'simplyhired.com',
];

// Title/snippet patterns that indicate aggregator pages rather than company homepages
const SKIP_TITLE_PATTERNS = [
  /\btop \d+\b/i,
  /\bbest \d+\b/i,
  /\blist of\b/i,
  /\bdirectory\b/i,
  /\bassociation\b/i,
  /\bwikipedia\b/i,
  /\breviews?\b/i,
];

function getDomain(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return url.toLowerCase(); }
}

/**
 * Returns true if the SerpResult is worth scraping given the parsed intent.
 * This is a fast, zero-cost pre-filter — not a quality gate.
 */
export function passesHeuristicFilter(
  result: SerpResult,
  intent: ParsedIntent,
): boolean {
  const domain = getDomain(result.url);
  const text = `${result.title} ${result.snippet}`.toLowerCase();

  // Reject known aggregator domains
  if (SKIP_DOMAIN_FRAGMENTS.some(frag => domain.includes(frag))) return false;

  const isEntityQuery =
    (intent.queryType === 'named_entity_list' || intent.queryType === 'contact_lookup') &&
    (intent.namedEntities?.length ?? 0) > 0;

  // Reject aggregator-style titles — but not for entity queries (a "list" page may contain the firm)
  if (!isEntityQuery) {
    if (SKIP_TITLE_PATTERNS.some(pat => pat.test(result.title))) return false;
  }

  // For entity queries: entity name match in text OR domain is sufficient — skip industry/geo check
  if (isEntityQuery) {
    const cleanedDomain = domain.replace(/[^a-z0-9]/g, '');
    const entityMatch = intent.namedEntities!.some(name => {
      const nameLower = name.toLowerCase();
      return text.includes(nameLower) || cleanedDomain.includes(nameLower.replace(/[^a-z0-9]/g, ''));
    });
    // Pass if entity name found; reject if not (no point scraping an unrelated page)
    return entityMatch;
  }

  // For demographic queries: skip if neither industry keyword nor geographic hint appears
  const industry = (intent.industry ?? '').toLowerCase().trim();
  // Empty/"other"/"unknown" are placeholders — don't use them as a filter signal
  const isPlaceholder = industry === '' || industry === 'other' || industry === 'unknown';
  const industryWords = isPlaceholder ? [] : industry.split(/\s+/);
  const geo = [intent.geography.country, intent.geography.city, intent.geography.state]
    .filter(Boolean)
    .map(s => s!.toLowerCase());

  const industryHit = industryWords.some(w => w.length > 3 && text.includes(w));
  const geoHit = geo.some(g => text.includes(g));

  // If industry is "other" and no geo is set, pass everything through (no useful filter signal)
  if (industryWords.length === 0 && geo.length === 0) return true;

  if (!industryHit && !geoHit) return false;

  return true;
}
