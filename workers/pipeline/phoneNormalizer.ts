import { parsePhoneNumberFromString, getCountryCallingCode, type PhoneNumber, type CountryCode } from 'libphonenumber-js';
import { logger } from '../utils/logger.js';

export interface NormalizedPhone {
  raw: string;
  normalized?: string;   // E.164 format: +2348012345678
  national?: string;     // national format: 0801 234 5678
  type?: 'office' | 'mobile' | 'fax';
  countryCode?: string;
  isValid: boolean;
}

/**
 * Attempts multiple parsing strategies for a single raw phone, in order of
 * preference. Returns the first PhoneNumber that `isValid()`, else undefined.
 *
 * Strategies (each tried with + without country hint):
 *   1. As-is (already E.164 or well-formed)
 *   2. If string starts with the country's calling code digits but lacks `+`,
 *      prepend `+` (e.g. "2348012345678" -> "+2348012345678")
 *   3. If string starts with "0" (local trunk prefix), strip it and prepend `+<cc>`
 *   4. Fall back to parsePhoneNumberFromString(raw, countryHint) — lets
 *      libphonenumber apply its own heuristics
 */
function tryParse(raw: string, countryHint?: CountryCode): PhoneNumber | undefined {
  const attempts: string[] = [raw];
  const digits = raw.replace(/[^\d+]/g, '');

  if (countryHint) {
    const cc = getCountryCallingCode(countryHint); // e.g. "234" for NG
    if (digits.startsWith(cc) && !digits.startsWith('+')) {
      attempts.push(`+${digits}`);
    }
    if (digits.startsWith('0')) {
      attempts.push(`+${cc}${digits.slice(1)}`);
    }
    if (!digits.startsWith('+') && !digits.startsWith(cc) && digits.length >= 7) {
      attempts.push(`+${cc}${digits}`);
    }
  }

  for (const attempt of attempts) {
    try {
      const parsed = parsePhoneNumberFromString(attempt, countryHint);
      if (parsed?.isValid()) return parsed;
    } catch {
      // fall through to next attempt
    }
  }
  return undefined;
}

export function normalizePhones(rawPhones: string[], countryHint?: string): NormalizedPhone[] {
  const results: NormalizedPhone[] = [];
  const seen = new Set<string>();
  const hint = countryHint as CountryCode | undefined;

  for (const raw of rawPhones) {
    const cleaned = raw.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);

    const parsed = tryParse(cleaned, hint);
    if (parsed) {
      const phoneType = parsed.getType();
      results.push({
        raw: cleaned,
        normalized: parsed.format('E.164'),
        national: parsed.formatNational(),
        type: phoneType === 'FIXED_LINE' ? 'office'
          : phoneType === 'MOBILE' ? 'mobile'
          : phoneType === 'FIXED_LINE_OR_MOBILE' ? 'office'
          : undefined,
        countryCode: parsed.country,
        isValid: true,
      });
    } else {
      results.push({ raw: cleaned, isValid: false });
    }
  }

  logger.info('phoneNormalizer: normalization complete', {
    total: rawPhones.length,
    valid: results.filter(r => r.isValid).length,
    hint,
  });
  return results;
}

// Convert ISO country name to 2-letter code (best-effort)
export function countryNameToCode(name?: string | null): string | undefined {
  if (!name) return undefined;
  const MAP: Record<string, string> = {
    'nigeria': 'NG', 'kenya': 'KE', 'ghana': 'GH', 'south africa': 'ZA',
    'united states': 'US', 'usa': 'US', 'united kingdom': 'GB', 'uk': 'GB',
    'canada': 'CA', 'australia': 'AU', 'india': 'IN', 'germany': 'DE',
    'france': 'FR', 'brazil': 'BR', 'egypt': 'EG', 'ethiopia': 'ET',
    'tanzania': 'TZ', 'uganda': 'UG', 'rwanda': 'RW', 'senegal': 'SN',
  };
  return MAP[name.toLowerCase()];
}
