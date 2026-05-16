import type { SerpResult } from './serpScraper.js';
import { logger } from '../utils/logger.js';

export interface AggregatorName {
  fullName: string;
  firstName?: string;
  lastName?: string;
  sourceUrl: string;
  sourceHost: string;
}

// Words that sometimes appear as URL-path segments but aren't names
const NAME_BLOCKLIST = new Set([
  'email', 'contact', 'profile', 'people', 'person', 'overview',
  'companies', 'company', 'employees', 'jobs', 'email_', 'address',
]);

function capitalize(word: string): string {
  if (!word) return word;
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

function looksLikeName(s: string): boolean {
  if (!s || s.length < 2 || s.length > 25) return false;
  if (NAME_BLOCKLIST.has(s.toLowerCase())) return false;
  if (/\d/.test(s)) return false;
  return /^[A-Za-z]+$/.test(s);
}

function host(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; }
  catch { return ''; }
}

/**
 * Pull a first-last name pair from an aggregator profile URL.
 * Returns null if the URL doesn't match a known aggregator pattern or the
 * extracted tokens don't look like names.
 *
 * Supported patterns:
 *   zoominfo.com/p/First-Last/ID
 *   zoominfo.com/pic/companyslug/ID               → no person name, skip
 *   rocketreach.co/first-last-email_ID
 *   rocketreach.co/first-last_ID
 *   contactout.com/first-last-NUMBER
 *   datanyze.com/people/Last-First/ID             (note: surname often first in URL)
 *   linkedin.com/in/first-last-hash                (common enough to support)
 *   signalhire.com/overview/slug                  → usually company, skip
 */
export function extractAggregatorName(url: string): AggregatorName | null {
  const h = host(url);
  const p = pathOf(url);

  // zoominfo /p/First-Last/ID
  if (h.includes('zoominfo.com')) {
    const m = p.match(/^\/p\/([A-Za-z]+)-([A-Za-z]+)(?:\/|$)/);
    if (m && looksLikeName(m[1]!) && looksLikeName(m[2]!)) {
      const firstName = capitalize(m[1]!);
      const lastName = capitalize(m[2]!);
      return { fullName: `${firstName} ${lastName}`, firstName, lastName, sourceUrl: url, sourceHost: h };
    }
    return null;
  }

  // rocketreach.co /first-last(-email)?_ID
  if (h.includes('rocketreach.co')) {
    const m = p.match(/^\/([a-z]+)-([a-z]+)(?:-email)?_/);
    if (m && looksLikeName(m[1]!) && looksLikeName(m[2]!)) {
      const firstName = capitalize(m[1]!);
      const lastName = capitalize(m[2]!);
      return { fullName: `${firstName} ${lastName}`, firstName, lastName, sourceUrl: url, sourceHost: h };
    }
    return null;
  }

  // contactout.com /first-last-NUMBER
  if (h.includes('contactout.com')) {
    const m = p.match(/^\/([a-z]+)-([a-z]+)-\d+/);
    if (m && looksLikeName(m[1]!) && looksLikeName(m[2]!)) {
      const firstName = capitalize(m[1]!);
      const lastName = capitalize(m[2]!);
      return { fullName: `${firstName} ${lastName}`, firstName, lastName, sourceUrl: url, sourceHost: h };
    }
    return null;
  }

  // datanyze.com /people/Surname-Firstname/ID  (order is commonly reversed in datanyze slugs)
  if (h.includes('datanyze.com')) {
    const m = p.match(/^\/people\/([A-Za-z]+)-([A-Za-z]+)(?:\/|$)/);
    if (m && looksLikeName(m[1]!) && looksLikeName(m[2]!)) {
      // Emit both orderings as candidates — cheap, and the agent/permuter will dedupe
      const a = capitalize(m[1]!);
      const b = capitalize(m[2]!);
      return { fullName: `${b} ${a}`, firstName: b, lastName: a, sourceUrl: url, sourceHost: h };
    }
    return null;
  }

  // linkedin.com/in/first-last-HASH
  if (h.includes('linkedin.com')) {
    const m = p.match(/^\/in\/([a-z]+)-([a-z]+)(?:-[a-z0-9]+)?/);
    if (m && looksLikeName(m[1]!) && looksLikeName(m[2]!)) {
      const firstName = capitalize(m[1]!);
      const lastName = capitalize(m[2]!);
      return { fullName: `${firstName} ${lastName}`, firstName, lastName, sourceUrl: url, sourceHost: h };
    }
    return null;
  }

  return null;
}

/**
 * Scan a batch of SERP results and collect unique person names from aggregator URLs.
 * De-duplicates by normalized full name.
 */
export function collectAggregatorNames(
  results: SerpResult[],
  existing: Map<string, AggregatorName> = new Map(),
): Map<string, AggregatorName> {
  for (const r of results) {
    const name = extractAggregatorName(r.url);
    if (!name) continue;
    const key = name.fullName.toLowerCase();
    if (!existing.has(key)) existing.set(key, name);
  }
  if (existing.size > 0) {
    logger.info('[aggregatorNameExtractor] collected names', {
      count: existing.size,
      sample: [...existing.values()].slice(0, 5).map(n => `${n.fullName} (${n.sourceHost})`),
    });
  }
  return existing;
}
