import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Google Maps Places API wrapper.
 *
 * Why Maps is the single biggest data unlock for the long-tail SME market:
 * Google Maps indexes virtually every business that has ever been
 * geo-tagged — including the bukkas, mama-puts, family-owned shops, and
 * sole-proprietor services that don't have websites, don't get press
 * coverage, and aren't in Hunter's email database. Maps Place Details
 * also returns phone numbers as a structured field, satisfying the
 * "give me a phone" half of most prospecting briefs without the agent
 * having to do its own phone discovery via SERP.
 *
 * Pricing (as of 2026):
 *   Text Search: $0.032 / call (returns up to 20 places)
 *   Place Details (basic fields): $0.017 / call
 * For a 7-candidate discovery: 1 Text Search + 7 Details = ~$0.15.
 *
 * The service no-ops gracefully when GOOGLE_MAPS_API_KEY is unset; the
 * caller is expected to fall back to other discovery sources.
 *
 * Docs:
 *   https://developers.google.com/maps/documentation/places/web-service/search-text
 *   https://developers.google.com/maps/documentation/places/web-service/details
 */

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';
const REQUEST_TIMEOUT_MS = 12_000;

export interface PlacesTextSearchHit {
  placeId: string;
  name: string;
  /** Free-text description of the address ("123 Main St, Lagos, Nigeria"). */
  formattedAddress?: string;
  /** Maps types — useful for distinguishing "restaurant" from "lodging". */
  types?: string[];
  /** Google's user-rating score (0-5). Not always present. */
  rating?: number;
  userRatingsTotal?: number;
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
}

export interface PlacesDetails {
  placeId: string;
  name: string;
  formattedAddress?: string;
  /** Phone number formatted for the place's country (e.g. "0803 123 4567"). */
  formattedPhoneNumber?: string;
  /** Phone number in international format (e.g. "+234 803 123 4567"). */
  internationalPhoneNumber?: string;
  /** The business's own website URL when set on the listing. */
  website?: string;
  url?: string; // The Maps URL for the place
}

export function isGoogleMapsConfigured(): boolean {
  return Boolean(env.GOOGLE_MAPS_API_KEY);
}

/**
 * Text Search — query Maps with a free-text query (e.g. "bukka in Lagos",
 * "small accounting firms in Abuja"). Returns up to 20 results with their
 * place_ids; call getPlaceDetails for phone/website data.
 */
export async function textSearch(
  query: string,
  opts: { region?: string } = {},
): Promise<PlacesTextSearchHit[]> {
  if (!env.GOOGLE_MAPS_API_KEY) return [];
  if (!query.trim()) return [];

  const params = new URLSearchParams({
    query: query.trim(),
    key: env.GOOGLE_MAPS_API_KEY,
  });
  // 'region' biases results toward the given country (.ng for Nigeria).
  if (opts.region) params.set('region', opts.region);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${PLACES_BASE}/textsearch/json?${params.toString()}`,
      { signal: controller.signal },
    );
    if (!res.ok) {
      logger.warn('[googleMapsPlaces] text-search non-200', {
        status: res.status, query: query.slice(0, 80),
      });
      return [];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any;
    if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
      logger.warn('[googleMapsPlaces] text-search returned non-OK status', {
        status: json.status, error: json.error_message,
      });
      return [];
    }
    if (!Array.isArray(json.results)) return [];

    return (json.results as Array<Record<string, unknown>>)
      .map((r) => ({
        placeId: String(r['place_id'] ?? ''),
        name: String(r['name'] ?? ''),
        formattedAddress: typeof r['formatted_address'] === 'string' ? r['formatted_address'] : undefined,
        types: Array.isArray(r['types']) ? r['types'] as string[] : undefined,
        rating: typeof r['rating'] === 'number' ? r['rating'] as number : undefined,
        userRatingsTotal: typeof r['user_ratings_total'] === 'number' ? r['user_ratings_total'] as number : undefined,
        businessStatus: typeof r['business_status'] === 'string' ? r['business_status'] as PlacesTextSearchHit['businessStatus'] : undefined,
      }))
      .filter((h) => h.placeId && h.name);
  } catch (err) {
    logger.warn('[googleMapsPlaces] text-search request failed', {
      err: err instanceof Error ? err.message : String(err),
      query: query.slice(0, 80),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Place Details — fetches phone, website, address for a place_id.
 * Restricts to the cheap "basic" fields to keep cost predictable.
 */
export async function getPlaceDetails(placeId: string): Promise<PlacesDetails | null> {
  if (!env.GOOGLE_MAPS_API_KEY) return null;
  if (!placeId) return null;

  const params = new URLSearchParams({
    place_id: placeId,
    key: env.GOOGLE_MAPS_API_KEY,
    // Comma-separated field mask. We only request what's actually useful
    // for prospecting; extra fields incur per-field billing tiers.
    fields: 'name,formatted_address,formatted_phone_number,international_phone_number,website,url',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${PLACES_BASE}/details/json?${params.toString()}`,
      { signal: controller.signal },
    );
    if (!res.ok) {
      logger.warn('[googleMapsPlaces] details non-200', { status: res.status, placeId });
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any;
    if (json.status !== 'OK') {
      logger.warn('[googleMapsPlaces] details returned non-OK status', {
        status: json.status, error: json.error_message,
      });
      return null;
    }
    const r = json.result as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      placeId,
      name: String(r['name'] ?? ''),
      formattedAddress: typeof r['formatted_address'] === 'string' ? r['formatted_address'] : undefined,
      formattedPhoneNumber: typeof r['formatted_phone_number'] === 'string' ? r['formatted_phone_number'] : undefined,
      internationalPhoneNumber: typeof r['international_phone_number'] === 'string' ? r['international_phone_number'] : undefined,
      website: typeof r['website'] === 'string' ? r['website'] : undefined,
      url: typeof r['url'] === 'string' ? r['url'] : undefined,
    };
  } catch (err) {
    logger.warn('[googleMapsPlaces] details request failed', {
      err: err instanceof Error ? err.message : String(err), placeId,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convenience: extract a root domain from a Maps website URL. Strips
 * protocol, www, and any path/query. Returns empty string when the URL
 * is malformed or absent.
 */
export function extractRootDomain(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    return u.host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
