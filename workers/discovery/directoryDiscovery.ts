import { logger } from '../utils/logger.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';
import { searchMany } from '../pipeline/searchProviders/router.js';
import type { SearchResultItem } from '../pipeline/searchProviders/types.js';
import type { ParsedIntent } from '../../shared/index.js';
import type { HybridCandidate } from '../pipeline/jobSubagent.js';

/**
 * Directory-based candidate discovery.
 *
 * The premise behind this module: an LLM's training corpus has a sharp
 * recall bias toward press-covered companies. When a user asks for "small
 * upcoming Nigerian businesses," asking the model to recall candidates
 * gives back the well-funded startups that *did* get press, not the
 * directory-listed small businesses that are exactly what the user wants.
 *
 * The fix is to source candidates from the open web — specifically from
 * Nigerian business directory sites where small businesses pay to be
 * listed. Snippets from those listings carry the company name + a brief
 * description, which the LLM then EXTRACTS rather than INVENTS.
 *
 * Trade-off: directory data is messier than LLM recall. Some entries are
 * defunct, duplicated, or category pages instead of real companies. The
 * downstream validation + enrichment passes catch most of the noise.
 *
 * This module is the discovery half of the same architectural shift we
 * already made for contact extraction (serpContactExtractor): stop asking
 * the LLM what it remembers, start asking the open web what it indexes.
 */

const DIRECTORY_HOSTS = [
  'vconnect.com',
  'finelib.com',
  'businesslist.com.ng',
  'connectnigeria.com',
  'nigeriagalleria.com',
  'nigeriayp.com',
  'nairalist.com',
  'nigerianbusinesslist.com',
  'expertsng.com',
  'zigi.ng',
];

/** Major Nigerian commercial hubs — reserved for future per-city fan-out
 *  when the brief doesn't pin a city. Not yet referenced; see tasks/todo.md
 *  Sprint 4. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const NIGERIA_HUBS = ['Lagos', 'Abuja', 'Port Harcourt'];

const SERP_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 30_000;

const EXTRACTION_SYSTEM_PROMPT = `You receive search results from Nigerian business directories. Extract real, individual company entries that match the user's brief.

OUTPUT — a single JSON object. First character "{", last character "}". No prose.

Schema:
{
  "candidates": [
    {
      "name": "<company name, exactly as it appears in the directory>",
      "domain": "<root domain if visible in the snippet, otherwise omit>",
      "description": "<one sentence from the snippet — what the company does>",
      "fitReason": "<one sentence explaining why this matches the user's brief>",
      "confidence": "high|medium|low",
      "sourceUrl": "<the directory listing URL the entry came from>"
    }
  ]
}

RULES:
1. Extract ONLY real individual companies. Skip category pages ("Construction Companies in Lagos", "Top 10 lists", "Directory of …"). Those have multiple companies in their snippets, not a single subject.
2. Skip blog posts and news articles unless they're profiling a single named company in detail.
3. Skip aggregators and listing-of-listings pages.
4. The user wants companies that MATCH THEIR BRIEF. If the brief excludes household names / wants small / upcoming companies, prefer the unfamiliar entries — directory pages are full of small businesses, not famous ones, so this should be the natural outcome anyway.
5. "domain" is optional. Most directory snippets don't include the company's own URL. Omit the field when not visible — the downstream pipeline finds the domain via search.
6. "fitReason" must be GROUNDED in the snippet content. If the snippet says "logistics services in Lagos", a fitReason like "ships goods nationwide" overstates what the snippet supports. Stick to what the snippet says.
7. "confidence" reflects how confident you are this is a real, currently-operating company that matches the brief:
   high = the snippet clearly identifies a real, operating company that fits
   medium = the snippet identifies a company but match-to-brief is partial
   low = uncertain; could be defunct or marginal fit
8. Skip duplicates. If two snippets describe the same company, return one entry.
9. Empty candidates array is a valid response. NEVER fabricate entries to hit a target count.
10. Maximum 25 candidates per call. Return the best-fit ones; don't pad.

A real company name has at least 2 words OR is a single distinctive proper noun (e.g. "Vatebra"). UI/category text ("View Listing", "Get Directions", "Business Categories", "Top Rated") is NOT a company. Discard.`;

interface ExtractedRaw {
  candidates?: Array<{
    name?: string;
    domain?: string;
    description?: string;
    fitReason?: string;
    confidence?: string;
    sourceUrl?: string;
  }>;
}

/**
 * Build SERP queries that target Nigerian business directories. We construct
 * 3-4 queries from different angles to maximise candidate yield from each
 * discovery call. Each query is one OR-joined site: clause across the
 * directory hosts plus an angle-specific term set.
 *
 * Why multiple angles: directories index pages by category, by location,
 * and by free-text keywords. A single query against any one of these
 * misses candidates indexed under a different facet. Three lightly-
 * different queries triple the snippet pool while still costing only
 * ~3 SERP credits per discovery call.
 */
function buildQueries(intent: ParsedIntent, rawQuery: string): string[] {
  // Split the directory hosts into two groups to keep individual `site:`
  // clauses short enough for Google to handle reliably (long OR-chains
  // sometimes get silently truncated). Each query then uses one group.
  const halfA = DIRECTORY_HOSTS.slice(0, Math.ceil(DIRECTORY_HOSTS.length / 2));
  const halfB = DIRECTORY_HOSTS.slice(Math.ceil(DIRECTORY_HOSTS.length / 2));
  const sitesA = halfA.map((h) => `site:${h}`).join(' OR ');
  const sitesB = halfB.map((h) => `site:${h}`).join(' OR ');

  const sanitise = (s: string) => s.replace(/[^a-zA-Z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();

  const industry = sanitise([intent.industry, intent.subIndustry].filter(Boolean).join(' '));
  const geo = sanitise([intent.geography?.city, intent.geography?.state, intent.geography?.country]
    .filter(Boolean)
    .join(' '));
  const country = intent.geography?.country ?? 'Nigeria';
  const keywords = sanitise((intent.keywords ?? []).slice(0, 4).join(' '));
  const briefTerms = extractBriefKeywords(rawQuery);

  // ── Buyer industries take precedence over offering keywords ─────────
  // When the parser detected `userOffering`, it should also have set
  // `targetBuyerIndustries` — the kinds of companies that BUY this
  // offering. Those drive the queries (one per industry, broad coverage)
  // instead of the user's own keywords/industry which describe the
  // offering itself. Without this, a "I sell travel-agency services"
  // brief returns travel agencies (the user's competitors) instead of
  // corporates that hire travel agencies.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buyerIndustries: string[] = Array.isArray((intent as any).targetBuyerIndustries)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? ((intent as any).targetBuyerIndustries as string[]).map(sanitise).filter(Boolean)
    : [];

  // Negative-match exclusions: if the user has an offering, the offering
  // terms should NOT appear in results — those would be competitor pages.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offeringExclusions: string = (intent as any).userOffering
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? buildOfferingExclusions((intent as any).userOffering as string)
    : '';

  // Pick the strongest "what kind of company" term we have. Buyer
  // industries win when present; otherwise fall back to industry / brief
  // / keywords as before.
  const subjectTerm = buyerIndustries.length > 0
    ? buyerIndustries.slice(0, 3).map(quoteIfMulti).join(' OR ')
    : (industry || briefTerms || keywords);

  const queries: string[] = [];

  if (subjectTerm) {
    const excl = offeringExclusions ? ` ${offeringExclusions}` : '';
    // Angle 1: half-A directories + subject + country
    queries.push(`(${sitesA}) ${subjectTerm} ${country}${excl}`);
    // Angle 2: half-B directories + subject + country
    queries.push(`(${sitesB}) ${subjectTerm} ${country}${excl}`);

    // Angle 3: a single city query for the largest commercial hub when no
    // city was pinned. One additional query — keeps SERP cost bounded.
    if (!intent.geography?.city) {
      queries.push(`(${sitesA}) ${subjectTerm} Lagos${excl}`);
    } else if (geo) {
      queries.push(`(${sitesB}) ${subjectTerm} ${geo}${excl}`);
    }
  }

  // Distinct keyword-only angle (when keywords differ from subject AND
  // there's no offering — keywords for an offering brief describe the
  // offering, not the buyer, so we skip them in that case).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasOffering = Boolean((intent as any).userOffering);
  if (!hasOffering && keywords && keywords !== briefTerms && keywords !== industry && keywords !== subjectTerm) {
    queries.push(`(${sitesB}) ${keywords} ${country}`);
  }

  // Final fallback if nothing else worked
  if (queries.length === 0 && rawQuery.trim()) {
    queries.push(`(${sitesA}) ${rawQuery.split(/[.!?\n]/)[0]?.slice(0, 120) ?? ''}`);
  }

  // De-dupe and cap at 4 — wider than the original 2-query setup but
  // narrow enough to leave SERP budget for downstream contact extraction.
  return Array.from(new Set(queries)).slice(0, 4);
}

/**
 * Quotes a multi-word term so Google treats it as a phrase. Single-word
 * terms are left bare. Used when joining buyer industries into an OR
 * clause: `("oil & gas" OR consulting OR "professional services")`.
 */
function quoteIfMulti(term: string): string {
  const t = term.trim();
  if (!t) return '';
  return /\s/.test(t) ? `"${t.replace(/"/g, '')}"` : t;
}

/**
 * Builds Google negative-match exclusion clauses from the user's stated
 * offering. The output looks like `-"travel agency" -"flight ticket"`
 * and gets appended to queries to keep the user's competitors out of
 * the result set.
 *
 * We extract the noun-ish offering terms, strip stopwords, and quote
 * multi-word terms for proper exclusion behaviour. Capped at 3 exclusions
 * so the query string stays inside Google's length limit.
 */
function buildOfferingExclusions(offering: string): string {
  if (!offering.trim()) return '';
  // Pull the salient nouns from the offering ("travel agency services
  // for staff bookings" → ["travel agency", "staff bookings"]).
  // Skip common filler verbs/prepositions.
  const STOP = new Set([
    'the','a','an','for','to','of','in','on','at','by','with','from',
    'and','or','our','my','your','their','his','her','its',
    'service','services','solution','solutions','platform','provider',
    'company','companies','business','businesses',
  ]);
  const tokens = offering
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
  if (tokens.length === 0) return '';
  // Build exclusion phrases: pair adjacent content words into 2-grams
  // when possible (catches "travel agency" rather than just "travel").
  const phrases: string[] = [];
  for (let i = 0; i < tokens.length && phrases.length < 3; i++) {
    if (i + 1 < tokens.length) {
      phrases.push(`"${tokens[i]} ${tokens[i + 1]}"`);
      i++; // skip the partner
    } else {
      phrases.push(tokens[i]!);
    }
  }
  return phrases.map((p) => `-${p}`).join(' ');
}

/**
 * Extracts noun-ish content terms from the raw user brief — skips common
 * verbs, pronouns, and intent words. Returns a short space-separated
 * string suitable for a SERP query keyword block.
 */
function extractBriefKeywords(rawQuery: string): string {
  if (!rawQuery.trim()) return '';
  const STOP = new Set([
    'i','we','you','he','she','they','them','it','my','our','your','their','its',
    'a','an','the','some','any','all','every','no','some','few','many','most',
    'is','are','was','were','be','been','being','have','has','had',
    'do','does','did','can','could','should','would','will','may','might','must',
    'and','or','but','so','then','if','because','as','of','to','for','from','with','without',
    'in','on','at','by','about','into','onto','through','out','off','over','under',
    'need','want','get','help','sell','reach','find','look','provide','provides','book','flight','flights','hotel','hotels','return','returns','make','makes',
    'business','businesses','company','companies','corporate','corporation','organization','organizations','organisation','organisations','client','clients','customer','customers',
    'service','services','staff','etc','others','also',
    'this','that','these','those','strictly','just','normal','daily','upcoming','popular','household','name','names','here','there',
    'good','great','best','worst','already','only','more','less','very','really','both','number','phone','email','address',
    'would','could','should','must',
    // Country-as-filler — redundant with the country variable that already
    // appears in queries; including it again leaks "nigeria Nigeria" into
    // the search string. Strip lowercase variants from briefTerms.
    'nigeria','nigerian','africa','african',
    // Common typos to ignore so they don't leak into SERP queries
    'avaition','accomodation','recieve',
  ]);
  const tokens = rawQuery
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
  // Keep the first 6 distinct content terms — they tend to be the actual subject
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
    if (kept.length >= 6) break;
  }
  return kept.join(' ');
}

/**
 * Filter SERP results to entries plausibly representing a single company.
 * Drops obvious category / list pages whose URL paths suggest a directory
 * index rather than a company listing.
 */
function isPlausibleCompanyResult(r: SearchResultItem): boolean {
  if (!r.snippet || r.snippet.trim().length < 20) return false;

  // URL-based filter — category index pages have predictable paths
  const urlLower = r.url.toLowerCase();
  const CATEGORY_HINTS = [
    '/category/', '/categories/', '/industry/', '/listings/', '/directory/',
    '/top-', '/best-', '/list-of-', '/companies/', '/business-categories',
  ];
  // We only DROP if the URL has a category hint AND the title looks like a list
  // ("Top 10", "List of"). Some real listings live under /companies/<slug>.
  const titleLower = r.title.toLowerCase();
  const titleListy = /(top \d+|list of|best of|directory of|categories|all companies)/i.test(titleLower);
  if (CATEGORY_HINTS.some((h) => urlLower.includes(h)) && titleListy) return false;

  return true;
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
  lines.push('DIRECTORY SEARCH RESULTS:', '');
  let i = 1;
  for (const r of results) {
    lines.push(`[${i}] ${r.title}`);
    lines.push(`    url: ${r.url}`);
    lines.push(`    ${r.snippet.replace(/\s+/g, ' ').trim().slice(0, 500)}`);
    lines.push('');
    i++;
    if (i > 60) break; // hard cap, keeps prompt size bounded
  }
  return lines.join('\n');
}

/**
 * Validates and normalises an LLM-emitted candidate from the directory
 * extraction step. Drops malformed entries (no name, single-token "name",
 * placeholder URLs).
 */
function validateCandidate(
  raw: NonNullable<ExtractedRaw['candidates']>[number],
): HybridCandidate | null {
  const name = (raw.name ?? '').trim();
  if (!name) return null;
  // Reject obvious non-company strings the LLM might emit
  if (name.split(/\s+/).filter(Boolean).length < 1) return null;
  if (/^(view|get|click|read|listing|category|companies?|business)$/i.test(name)) return null;

  const sourceUrl = (raw.sourceUrl ?? '').trim();
  const validSourceUrl = sourceUrl.startsWith('http') ? sourceUrl : '';

  const domain = (raw.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

  const confidence: HybridCandidate['confidence'] =
    raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
      ? raw.confidence
      : 'medium';

  return {
    name,
    // Domain is optional from a directory result. We pass the root domain
    // when the LLM extracted one from the snippet; otherwise empty string,
    // which downstream validateCandidates treats as domain-unverified.
    domain: domain && domain.includes('.') ? domain : '',
    description: (raw.description ?? '').trim().slice(0, 400),
    fitReason: (raw.fitReason ?? '').trim().slice(0, 400),
    confidence,
    signals: validSourceUrl ? [`directory:${new URL(validSourceUrl).host}`] : ['directory_extracted'],
    domainUnverified: !domain,
  };
}

/**
 * Discover candidate companies from Nigerian business directories.
 *
 * Returns [] on any failure path; the caller is expected to fall back to
 * (or augment with) LLM-recall discovery.
 */
export async function discoverFromDirectories(
  intent: ParsedIntent,
  rawQuery: string,
  targetCount: number,
): Promise<HybridCandidate[]> {
  if (!isLlmConfigured()) {
    logger.warn('[directoryDiscovery] LLM not configured — skipping');
    return [];
  }

  const queries = buildQueries(intent, rawQuery);
  if (queries.length === 0) {
    logger.info('[directoryDiscovery] no usable queries built — skipping', {
      industry: intent.industry, geo: intent.geography,
    });
    return [];
  }
  logger.info('[directoryDiscovery] queries built', {
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
    logger.warn('[directoryDiscovery] SERP fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const filtered = results.filter(isPlausibleCompanyResult);
  if (filtered.length === 0) {
    logger.info('[directoryDiscovery] zero plausible directory results', {
      raw_results: results.length,
    });
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
      max_tokens: 3000,
      temperature: 0,
      response_format: { type: 'json_object' },
      timeoutMs: LLM_TIMEOUT_MS,
    });
  } catch (err) {
    logger.warn('[directoryDiscovery] LLM extraction failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const json = extractFirstJsonObject(raw);
  if (!json) {
    logger.warn('[directoryDiscovery] LLM returned no JSON');
    return [];
  }

  let parsed: ExtractedRaw;
  try {
    parsed = JSON.parse(json) as ExtractedRaw;
  } catch {
    logger.warn('[directoryDiscovery] invalid JSON from LLM');
    return [];
  }

  const candidates = (parsed.candidates ?? [])
    .map((c) => validateCandidate(c))
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

  logger.info('[directoryDiscovery] extraction complete', {
    queries: queries.length,
    snippets: filtered.length,
    proposed: deduped.length,
    target: targetCount,
    industry: intent.industry,
  });

  return deduped;
}
