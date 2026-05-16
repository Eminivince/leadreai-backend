import { logger } from '../utils/logger.js';
import { textSearch, getPlaceDetails, isGoogleMapsConfigured, extractRootDomain } from '../services/googleMapsPlaces.js';
import type { ParsedIntent } from '../../shared/index.js';
import type { HybridCandidate } from '../pipeline/jobSubagent.js';

/**
 * Discovers candidate companies via Google Maps Places API.
 *
 * Why this is the highest-leverage source for the long-tail SME market:
 * Maps indexes EVERY business with any physical or geo-tagged presence —
 * including the bukkas, mama-puts, family shops, single-location services,
 * and small operators that have no website, no press coverage, and no
 * Hunter data. Maps Place Details also returns the business's phone
 * number directly, which means the lead arrives with reachable contact
 * data without needing the agent to go discover it via SERP.
 *
 * Cost: ~$0.15 per discovery (1 Text Search + ~7 Place Details). Returns
 * up to 7 candidates per query. No-ops gracefully when GOOGLE_MAPS_API_KEY
 * is unset — the caller falls back to other discovery sources.
 */

const MAX_DETAILS_FETCHES = 8; // cap to bound cost per discovery
const PARALLELISM = 4; // simultaneous Place Details requests

/**
 * Build a Maps Text Search query from the user's intent. Maps' search
 * works best with natural-language queries like "small restaurants in
 * Lagos" rather than tag-style "fintech Nigeria".
 */
function buildSearchQuery(intent: ParsedIntent, rawQuery: string): string {
  const sanitise = (s: string) => s.replace(/[^a-zA-Z0-9\s'&-]/g, ' ').replace(/\s+/g, ' ').trim();
  const location = [intent.geography?.city, intent.geography?.state, intent.geography?.country]
    .filter(Boolean)
    .join(', ');

  // Buyer industries take precedence when the user has an offering — we
  // want to find their target customers, not businesses similar to their
  // own offering. Maps doesn't take OR-clauses well, so we pick the
  // first/strongest industry; downstream callers can iterate the rest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buyerIndustries: string[] = Array.isArray((intent as any).targetBuyerIndustries)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? ((intent as any).targetBuyerIndustries as string[]).map(sanitise).filter(Boolean)
    : [];
  if (buyerIndustries.length > 0) {
    const term = buyerIndustries[0]!;
    return `${term} in ${location || 'Nigeria'}`;
  }

  const subject = sanitise([intent.industry, intent.subIndustry].filter(Boolean).join(' '));
  if (subject && location) return `${subject} in ${location}`;
  if (subject) return `${subject} in Nigeria`;

  // Last resort: pull noun-ish terms from the raw brief. Skip the brief
  // entirely when an offering is set — those keywords describe the
  // offering, not the target buyer, and Maps would return competitors.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasOffering = Boolean((intent as any).userOffering);
  if (!hasOffering) {
    const cleanedBrief = rawQuery
      .split(/[.!?\n]/)[0]
      ?.replace(/[^a-zA-Z0-9\s'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (cleanedBrief) return `${cleanedBrief} in ${location || 'Nigeria'}`;
  }

  return `business in ${location || 'Nigeria'}`;
}

/**
 * Process a Maps text-search hit + place-details into a HybridCandidate.
 * Returns null when essential fields are missing.
 */
function buildCandidate(
  hit: { name: string; placeId: string; types?: string[]; formattedAddress?: string; rating?: number; userRatingsTotal?: number },
  details: { website?: string; formattedPhoneNumber?: string; internationalPhoneNumber?: string; formattedAddress?: string } | null,
): HybridCandidate | null {
  const name = hit.name.trim();
  if (!name) return null;

  const websiteUrl = details?.website ?? '';
  const domain = extractRootDomain(websiteUrl);

  // Use the international phone preferentially (E.164-ish, normalisable).
  // Maps returns both `internationalPhoneNumber` and `formattedPhoneNumber`
  // for the same line — they're the same number in different formats, so
  // we only emit ONE seed value and let downstream phoneNormalizer canonicalise.
  const seedPhones: string[] = [];
  const phone = details?.internationalPhoneNumber || details?.formattedPhoneNumber;
  if (phone) seedPhones.push(phone);

  const types = (hit.types ?? []).filter(Boolean);
  const ratingTag = hit.rating != null && hit.userRatingsTotal != null
    ? `${hit.rating}★ (${hit.userRatingsTotal} reviews)` : null;
  const signals: string[] = [`google_maps`, ...types.slice(0, 3)];
  if (ratingTag) signals.push(ratingTag);

  return {
    name,
    domain: domain || '',
    description: hit.formattedAddress ?? details?.formattedAddress ?? '',
    fitReason: `Listed on Google Maps under ${types.slice(0, 2).join(' / ') || 'a relevant business category'}${ratingTag ? `, with ${ratingTag}` : ''}. ${seedPhones.length > 0 ? 'Phone number on file.' : 'No phone listed on Maps.'}`.trim(),
    confidence: seedPhones.length > 0 ? 'high' : 'medium',
    signals,
    ...(domain ? {} : { domainUnverified: true }),
    ...(seedPhones.length > 0 ? { seedPhones } : {}),
    ...(details?.formattedAddress ? { seedAddress: details.formattedAddress } : {}),
  };
}

/**
 * Maps queries are billed per call; cap parallelism to keep predictable
 * latency without burning quota on a single job.
 */
async function fetchDetailsConcurrent(
  placeIds: string[],
): Promise<Array<{ placeId: string; details: Awaited<ReturnType<typeof getPlaceDetails>> }>> {
  const results: Array<{ placeId: string; details: Awaited<ReturnType<typeof getPlaceDetails>> }> = [];
  const queue = [...placeIds];
  const workers = Array.from({ length: Math.min(PARALLELISM, queue.length) }).map(async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      const details = await getPlaceDetails(id);
      results.push({ placeId: id, details });
    }
  });
  await Promise.all(workers);
  return results;
}

export async function discoverFromGoogleMaps(
  intent: ParsedIntent,
  rawQuery: string,
  targetCount: number,
): Promise<HybridCandidate[]> {
  if (!isGoogleMapsConfigured()) {
    logger.info('[googleMapsDiscovery] GOOGLE_MAPS_API_KEY not configured — skipping');
    return [];
  }

  // When the parser identified buyer industries (offering-style brief),
  // run one text search per industry so each buyer sector gets its own
  // candidate pool. Otherwise a single industry/subject query covers it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buyerIndustries: string[] = Array.isArray((intent as any).targetBuyerIndustries)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? ((intent as any).targetBuyerIndustries as string[]).filter(Boolean)
    : [];
  const queries = buyerIndustries.length > 0
    ? buyerIndustries.slice(0, 4).map((ind) => {
        const location = [intent.geography?.city, intent.geography?.state, intent.geography?.country]
          .filter(Boolean)
          .join(', ');
        return `${ind.replace(/[^a-zA-Z0-9\s'&-]/g, ' ').trim()} in ${location || 'Nigeria'}`;
      })
    : [buildSearchQuery(intent, rawQuery)];

  logger.info('[googleMapsDiscovery] running text searches', {
    queries: queries.slice(0, 4), target: targetCount, buyer_industries: buyerIndustries.length,
  });

  const hitsLists = await Promise.all(queries.map((q) => textSearch(q, { region: 'ng' })));

  // Round-robin interleave + dedup by placeId. Each query gets a fair
  // share of the Place-Details slot budget. Without this, the first
  // query's hits flood the flattened list and slice(0, MAX_DETAILS_FETCHES)
  // takes them all — defeating the entire point of running multiple
  // buyer-industry queries (sector concentration, oil-&-gas dominating).
  const seenPlaceIds = new Set<string>();
  const interleaved: typeof hitsLists[number] = [];
  const maxPerQuery = Math.max(0, ...hitsLists.map((l) => l.length));
  for (let i = 0; i < maxPerQuery; i++) {
    for (const list of hitsLists) {
      const hit = list[i];
      if (!hit) continue;
      if (seenPlaceIds.has(hit.placeId)) continue;
      seenPlaceIds.add(hit.placeId);
      interleaved.push(hit);
    }
  }
  const hits = interleaved;

  if (hits.length === 0) {
    logger.info('[googleMapsDiscovery] zero text-search results', { queries });
    return [];
  }

  // Filter operationally-closed places — Maps still indexes them but the
  // contact data is stale and the user can't reach them anyway.
  let live = hits.filter((h) => h.businessStatus !== 'CLOSED_PERMANENTLY');

  // When the user excluded household / well-known names, drop hits with
  // a high review count — that's the only popularity signal Maps gives
  // us. Coarse: catches consumer-facing brands (gas stations, retail
  // chains) but misses B2B-only big names with no consumer reviews.
  // The discoveryPrompt's retrieval-bias rule covers those at LLM-
  // recall time. Threshold of 300 was picked empirically — Lagos SMEs
  // typically have under 100 reviews; chains start crossing 300+.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((intent as any).excludeWellKnown === true) {
    const before = live.length;
    live = live.filter((h) => (h.userRatingsTotal ?? 0) <= 300);
    if (live.length < before) {
      logger.info('[googleMapsDiscovery] excluded well-known hits', {
        filtered_out: before - live.length,
        kept: live.length,
        threshold: 300,
      });
    }
  }

  // Cap detail fetches at a bounded number to control cost.
  const targets = live.slice(0, Math.max(targetCount, MAX_DETAILS_FETCHES));
  const detailsResults = await fetchDetailsConcurrent(targets.map((t) => t.placeId));
  const detailsByPlaceId = new Map(detailsResults.map((r) => [r.placeId, r.details]));

  const candidates: HybridCandidate[] = [];
  for (const hit of targets) {
    const details = detailsByPlaceId.get(hit.placeId) ?? null;
    const c = buildCandidate(hit, details);
    if (c) candidates.push(c);
  }

  // Dedup by lowercased name (Maps occasionally returns chain branches as
  // separate entries; for prospecting we want the parent business once).
  const seen = new Set<string>();
  const deduped: HybridCandidate[] = [];
  for (const c of candidates) {
    const key = c.name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  logger.info('[googleMapsDiscovery] complete', {
    queries,
    raw_hits: hits.length,
    live_hits: live.length,
    details_fetched: targets.length,
    candidates: deduped.length,
    with_phone: deduped.filter((c) => c.seedPhones && c.seedPhones.length > 0).length,
  });

  return deduped;
}
