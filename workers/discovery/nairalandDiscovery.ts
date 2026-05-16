import { logger } from '../utils/logger.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';
import { searchMany } from '../pipeline/searchProviders/router.js';
import type { SearchResultItem } from '../pipeline/searchProviders/types.js';
import type { ParsedIntent } from '../../shared/index.js';
import type { HybridCandidate } from '../pipeline/jobSubagent.js';

/**
 * Nairaland thread mining.
 *
 * Nairaland is the largest general-purpose Nigerian forum. Its threads
 * are full of free-text recommendations like "best mama put in Surulere"
 * or "small accounting firms in Abuja that aren't expensive" — exactly
 * the long-tail SME data that doesn't appear in directories or on Maps.
 * Posts often include phone numbers and Instagram/WhatsApp handles.
 *
 * Strategy:
 *   1. SERP-target Nairaland with the brief's terms (catches relevant threads)
 *   2. Use the SERP snippets directly — Nairaland snippets in Google preview
 *      typically include the post's first ~200 chars, which is enough to
 *      surface the business name + phone when the post is short. This is
 *      cheaper than fetching whole threads (no Playwright cost, no deep
 *      crawl risk) and already produces useful results.
 *   3. LLM extracts business name + phone (when present) per thread mention.
 *
 * If snippet-only proves thin, the future upgrade is to fetch top 2-3
 * thread URLs via Playwright and run the same extraction on the full post
 * content. For now we stay snippet-only to keep costs bounded.
 */

const SERP_TIMEOUT_MS = 25_000;
const LLM_TIMEOUT_MS = 30_000;
const MAX_QUERIES = 3;

const EXTRACTION_SYSTEM_PROMPT = `You receive snippets from Nairaland (a Nigerian forum). Each snippet is a thread title + post preview. Extract individual businesses being recommended or mentioned, with their phone number and any contact details if the post includes them.

OUTPUT — single JSON object. First character "{", last character "}". No prose.

Schema:
{
  "candidates": [
    {
      "name": "<business name as mentioned>",
      "phone": "<phone number from the post, if any>",
      "instagram": "<@handle if mentioned>",
      "whatsapp": "<phone number designated as whatsapp, if any>",
      "description": "<one short sentence summarising what the post says about this business>",
      "fitReason": "<one sentence on why this matches the user's brief, citing the snippet>",
      "confidence": "high|medium|low",
      "sourceUrl": "<the snippet URL>"
    }
  ]
}

RULES:
1. ONLY extract businesses being recommended/discussed positively or neutrally. Skip rants, complaints, and "avoid X" warnings.
2. Names should be exactly as written in the post — keep the original spelling and capitalisation. Strip "I recommend" / "you should try" prefixes.
3. Phone numbers: extract the digits as the post wrote them. Nigerian formats: +234..., 0803..., 0703..., +234 1 ..., etc. If the post mentions multiple numbers, pick the one most clearly tied to the business.
4. Skip generic discussion of business categories ("Lagos has many bukkas") — only extract specific named businesses.
5. Skip threads that are clearly off-topic for the brief (the SERP query may have been broad).
6. Multiple businesses in one thread is fine — emit each as a separate candidate.
7. NEVER fabricate a phone, handle, or name. If unsure, omit the field.
8. Empty candidates array is valid. NEVER pad.
9. Maximum 12 candidates per call. Pick the most clearly-named, most-clearly-recommended.
10. confidence: high = name + phone both clearly stated. medium = name clear, phone unclear or missing. low = name slightly ambiguous.

Discard non-business strings as candidates: "the manager", "my cousin", "Lagos", "Abuja", "good food", "delicious", "expensive". Real businesses have proper-noun names.`;

interface ExtractedRaw {
  candidates?: Array<{
    name?: string;
    phone?: string;
    instagram?: string;
    whatsapp?: string;
    description?: string;
    fitReason?: string;
    confidence?: string;
    sourceUrl?: string;
  }>;
}

function buildQueries(intent: ParsedIntent, rawQuery: string): string[] {
  const sanitise = (s: string) => s.replace(/[^a-zA-Z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const subject = sanitise([intent.industry, intent.subIndustry].filter(Boolean).join(' '));
  const country = intent.geography?.country ?? 'Nigeria';
  const city = intent.geography?.city;
  const keywords = sanitise((intent.keywords ?? []).slice(0, 4).join(' '));

  // Buyer industries take precedence when offering-style brief — search
  // Nairaland for each buyer industry separately to surface threads about
  // that customer segment rather than the user's offering itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buyerIndustries: string[] = Array.isArray((intent as any).targetBuyerIndustries)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? ((intent as any).targetBuyerIndustries as string[]).map(sanitise).filter(Boolean)
    : [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasOffering = Boolean((intent as any).userOffering);

  const queries: string[] = [];

  if (buyerIndustries.length > 0) {
    for (const ind of buyerIndustries.slice(0, MAX_QUERIES)) {
      queries.push(`site:nairaland.com "${ind}" ${city || country}`);
    }
  } else {
    const term = subject || keywords;
    if (term) {
      queries.push(`site:nairaland.com ${term} ${city || country}`);
      if (city && country !== city) queries.push(`site:nairaland.com ${term} ${country}`);
    }
    // Brief-keyword fallback only when no offering — otherwise the brief
    // text would describe the offering and surface competitor threads.
    if (!hasOffering && !subject && rawQuery.trim()) {
      const cleanedBrief = rawQuery.split(/[.!?\n]/)[0]?.replace(/[^a-zA-Z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (cleanedBrief) queries.push(`site:nairaland.com ${cleanedBrief}`);
    }
  }

  return Array.from(new Set(queries)).slice(0, MAX_QUERIES);
}

function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function buildCorpus(brief: string, results: SearchResultItem[]): string {
  const lines: string[] = [`USER BRIEF: ${brief.slice(0, 600)}`, ''];
  lines.push('NAIRALAND THREAD SNIPPETS:', '');
  let i = 1;
  for (const r of results) {
    if (!r.snippet || r.snippet.trim().length < 20) continue;
    lines.push(`[${i}] ${r.title}`);
    lines.push(`    url: ${r.url}`);
    lines.push(`    ${r.snippet.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
    lines.push('');
    i++;
    if (i > 30) break;
  }
  return lines.join('\n');
}

function normalisePhone(s: string): string {
  // Strip everything except digits and the leading +
  const cleaned = s.trim().replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  // Nigerian numbers without prefix → assume +234
  if (/^0\d{10}$/.test(cleaned)) return `+234${cleaned.slice(1)}`;
  if (/^\d{10}$/.test(cleaned)) return `+234${cleaned}`;
  return cleaned;
}

function buildCandidate(
  raw: NonNullable<ExtractedRaw['candidates']>[number],
): HybridCandidate | null {
  const name = (raw.name ?? '').trim();
  if (!name) return null;
  // Reject single-word junk and obvious non-business strings
  if (name.length < 3) return null;
  if (/^(the|my|good|nice|some|a|an|recommended|recommend)\b/i.test(name)) return null;

  const phones: string[] = [];
  if (raw.phone) {
    const p = normalisePhone(raw.phone);
    if (p && p.length >= 10) phones.push(p);
  }
  if (raw.whatsapp && raw.whatsapp !== raw.phone) {
    const p = normalisePhone(raw.whatsapp);
    if (p && p.length >= 10 && !phones.includes(p)) phones.push(p);
  }

  const sourceUrl = (raw.sourceUrl ?? '').trim();
  const validSourceUrl = sourceUrl.startsWith('http') ? sourceUrl : '';

  const confidence: HybridCandidate['confidence'] =
    raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
      ? raw.confidence
      : 'medium';

  return {
    name,
    domain: '',
    description: (raw.description ?? '').slice(0, 400),
    fitReason: (raw.fitReason ?? '').slice(0, 400),
    confidence,
    signals: [
      'nairaland_extracted',
      ...(raw.instagram ? [`ig:${raw.instagram.replace(/^@/, '')}`] : []),
      ...(validSourceUrl ? [`source:nairaland`] : []),
    ],
    domainUnverified: true,
    ...(phones.length > 0 ? { seedPhones: phones } : {}),
  };
}

export async function discoverFromNairaland(
  intent: ParsedIntent,
  rawQuery: string,
  targetCount: number,
): Promise<HybridCandidate[]> {
  if (!isLlmConfigured()) {
    logger.warn('[nairalandDiscovery] LLM not configured — skipping');
    return [];
  }

  const queries = buildQueries(intent, rawQuery);
  if (queries.length === 0) {
    logger.info('[nairalandDiscovery] no usable queries built — skipping');
    return [];
  }
  logger.info('[nairalandDiscovery] queries built', {
    count: queries.length,
    queries: queries.map((q) => q.length > 200 ? q.slice(0, 200) + '…' : q),
  });

  let results: SearchResultItem[] = [];
  try {
    results = await Promise.race([
      searchMany(queries),
      new Promise<SearchResultItem[]>((_, reject) =>
        setTimeout(() => reject(new Error('serp_timeout')), SERP_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    logger.warn('[nairalandDiscovery] SERP fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  // Keep only nairaland.com results — sometimes SERP returns mirrored or
  // cached copies on different hosts.
  const filtered = results.filter((r) => {
    try {
      return new URL(r.url).host.toLowerCase().includes('nairaland.com');
    } catch {
      return false;
    }
  });

  if (filtered.length === 0) {
    logger.info('[nairalandDiscovery] zero nairaland snippets returned');
    return [];
  }

  const corpus = buildCorpus(rawQuery, filtered);

  let raw: string;
  try {
    raw = await callLlm({
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: corpus },
      ],
      max_tokens: 2400,
      temperature: 0,
      response_format: { type: 'json_object' },
      timeoutMs: LLM_TIMEOUT_MS,
    });
  } catch (err) {
    logger.warn('[nairalandDiscovery] LLM extraction failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const json = extractFirstJsonObject(raw);
  if (!json) {
    logger.warn('[nairalandDiscovery] LLM returned no JSON');
    return [];
  }

  let parsed: ExtractedRaw;
  try {
    parsed = JSON.parse(json) as ExtractedRaw;
  } catch {
    logger.warn('[nairalandDiscovery] invalid JSON from LLM');
    return [];
  }

  const candidates = (parsed.candidates ?? [])
    .map((c) => buildCandidate(c))
    .filter((c): c is HybridCandidate => c !== null);

  // Dedup by lowercased name
  const seen = new Set<string>();
  const deduped: HybridCandidate[] = [];
  for (const c of candidates) {
    const key = c.name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  logger.info('[nairalandDiscovery] complete', {
    queries: queries.length,
    snippets: filtered.length,
    proposed: deduped.length,
    target: targetCount,
    with_phone: deduped.filter((c) => c.seedPhones && c.seedPhones.length > 0).length,
  });

  return deduped;
}
