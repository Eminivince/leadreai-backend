import { logger } from '../utils/logger.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';
import { searchMany } from '../pipeline/searchProviders/router.js';
import type { SearchResultItem } from '../pipeline/searchProviders/types.js';

/**
 * SERP-first contact extraction.
 *
 * Premise: most Nigerian SMEs and small B2B companies don't publish team
 * pages, so scraping the company website returns nothing useful for ~80%
 * of the target market. But Google does index press releases, LinkedIn
 * profiles, news articles, and bios — and those snippets *do* contain
 * named individuals tied to the company.
 *
 * This extractor runs 2-3 targeted queries (e.g. `"<Company>" founder`,
 * `site:linkedin.com/in "<Company>"`), bundles the snippet text from the
 * top results, and asks a fast LLM to extract `{ fullName, title, sourceUrl }`
 * triples. No page fetches — just snippet reading. Cheap and surprisingly
 * accurate because Google's preview text already concentrates the
 * relevance signal.
 *
 * Returns [] on any failure path so the caller can fall back to the
 * existing scrape-based extractor.
 */

export interface SerpContact {
  fullName: string;
  title?: string;
  sourceUrl: string;
  /** 0-1; conservative default 0.5 since we have no provider verification. */
  confidence: number;
}

interface SerpExtractedResponse {
  contacts: Array<{ fullName?: string; title?: string; sourceUrl?: string }>;
}

const EXTRACTION_SYSTEM_PROMPT = `You receive search-result snippets about a single company. Your job is to extract named individuals who are explicitly affiliated with the company in a professional capacity.

OUTPUT — a single JSON object. First character "{", last character "}". No prose.

Schema:
{ "contacts": [{ "fullName": "<First Last>", "title": "<role at the company>", "sourceUrl": "<the snippet URL the name came from>" }] }

RULES:
1. Only include a person if the snippet EXPLICITLY ties them to the target company. "John Smith, CEO of <Company>" → include. "John Smith said companies should..." → skip; not tied.
2. Title must describe the person's role AT THE TARGET COMPANY. If a snippet says "Jane Doe, formerly of Acme, now at Beta", and the target is Acme, do not include Jane (she has left).
3. Skip generic phrases like "our CEO" or "the founder" with no name attached.
4. Skip names that match the company name itself (e.g. for "Smith Holdings", do not return "Smith Holdings" as a person).
5. Skip pronouns, brand names, products, and roles without people.
6. Skip people whose only context is being quoted in an article unless their company affiliation is stated.
7. Title may be omitted if the snippet states a person without a clear role. fullName is required.
8. sourceUrl is REQUIRED — copy the URL from the snippet entry the name came from.
9. Empty contacts array is a valid response. NEVER fabricate entries.
10. Maximum 5 contacts. Prioritisation rules below.

PRIORITISATION:
- If the prompt's USER MESSAGE includes a "TARGET PERSONA" line, prioritise people whose role best matches that persona. The persona may describe ANY role: HR director, VP Sales, CTO, procurement lead, marketing head, founder, owner, etc. — read it carefully.
- If no persona is specified, return the most senior / most clearly affiliated named individuals.
- Don't artificially restrict to C-suite when the persona points elsewhere. An "HR manager" search should return HR managers, not the CEO.

A real person's name has at least 2 words. Single-word "names" like "Helpful" or "Marketing" are not people. UI/navigation phrases ("Helpful Tips", "About Us", "Contact Page", "Get Started", "Read More") are NOT people — discard.`;

const SERP_TIMEOUT_BUDGET_MS = 30_000;

/**
 * Builds the targeted query set for a company. Up to 3 queries — keep low
 * because each query burns SERP credit and most jobs have many candidates.
 *
 * When `roleKeywords` is provided (e.g. ["VP Sales", "head of sales"]), the
 * queries are persona-targeted. Otherwise we cast a wide net across all
 * common business roles — not just C-suite — so the LLM extraction step
 * sees a diverse cast of candidate people and can pick the right one based
 * on the persona context.
 */
function buildQueries(companyName: string, roleKeywords?: string[]): string[] {
  // Quote the company name so multi-word matches stay tight; otherwise we
  // get garbage-rich results for generic words like "construction" or
  // "consulting".
  const q = `"${companyName.replace(/"/g, '')}"`;

  // Targeted: caller knows the role they want. Prefix queries with the
  // role keyword so Google ranks pages that contain BOTH the company AND
  // the role above general company chatter.
  if (roleKeywords && roleKeywords.length > 0) {
    const roles = roleKeywords
      .slice(0, 6)
      .map((k) => k.includes(' ') ? `"${k}"` : k)
      .join(' OR ');
    return [
      `${q} ${roles}`,
      `site:linkedin.com/in ${q} ${roles}`,
      `${q} ${roles} Nigeria`,
    ];
  }

  // Default: no specific persona known. Cover the full range of business
  // roles — leadership AND functional managers — so HR, sales, procurement,
  // engineering people can surface alongside founders/CEOs. The LLM
  // extraction step filters to whoever best matches the user's brief.
  return [
    `${q} CEO OR founder OR owner OR director OR head OR VP OR manager OR lead`,
    `site:linkedin.com/in ${q}`,
    `${q} Nigeria team OR staff OR leadership OR HR OR sales OR operations`,
  ];
}

/**
 * Builds the user-message corpus the LLM extracts from. Each snippet is a
 * 3-line block with title, URL, and snippet text — small enough to fit many
 * snippets in a single ~1500-token call.
 *
 * When personaContext is provided, it goes at the top so the LLM filters
 * to the right people rather than defaulting to whoever is most senior.
 */
function buildCorpus(
  companyName: string,
  results: SearchResultItem[],
  personaContext?: string,
): string {
  const lines: string[] = [`TARGET COMPANY: ${companyName}`];
  if (personaContext && personaContext.trim()) {
    lines.push(`TARGET PERSONA: ${personaContext.trim().slice(0, 600)}`);
  }
  lines.push('', 'SNIPPETS (from web search):', '');
  let i = 1;
  for (const r of results) {
    if (!r.snippet || r.snippet.trim().length < 10) continue;
    lines.push(`[${i}] ${r.title}`);
    lines.push(`    url: ${r.url}`);
    lines.push(`    ${r.snippet.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
    lines.push('');
    i++;
    if (i > 30) break; // hard cap — keep prompt size bounded
  }
  return lines.join('\n');
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

/**
 * Validate an LLM-emitted contact entry. Filters obvious bad shapes (empty
 * names, single-word "names", names that match the company itself).
 */
function validateContact(
  raw: { fullName?: string; title?: string; sourceUrl?: string },
  companyName: string,
): SerpContact | null {
  const fullName = (raw.fullName ?? '').trim();
  const sourceUrl = (raw.sourceUrl ?? '').trim();

  if (!fullName || !sourceUrl.startsWith('http')) return null;
  // Need at least 2 word-tokens (a real human name)
  const tokens = fullName.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  // Reject "name" that matches the company verbatim
  if (fullName.toLowerCase() === companyName.toLowerCase()) return null;
  // Reject all-caps or all-lower (real names are usually Title Case)
  if (fullName === fullName.toUpperCase() && fullName.length > 8) return null;

  return {
    fullName,
    title: raw.title ? raw.title.trim().slice(0, 120) : undefined,
    sourceUrl,
    confidence: 0.6, // SERP-extracted: better than guess, weaker than verified
  };
}

export interface SerpExtractOpts {
  companyDomain?: string;
  /** Optional one-line description of the target persona (e.g. "Head of HR
   *  at mid-sized fintechs", or just the user's rawQuery). The LLM uses
   *  this to prioritise the right people from the snippet corpus. */
  personaContext?: string;
  /** Optional explicit role keywords to inject into SERP queries (e.g.
   *  ["VP Sales", "head of sales", "sales director"]). When provided,
   *  Google ranks pages that mention BOTH the company AND the role above
   *  general company chatter. When omitted, queries cast a wide net
   *  across all common business roles. */
  roleKeywords?: string[];
}

/**
 * Public entry point. Returns extracted contacts (may be empty).
 */
export async function extractContactsFromSerp(
  companyName: string,
  opts: SerpExtractOpts = {},
): Promise<SerpContact[]> {
  if (!companyName.trim()) return [];
  if (!isLlmConfigured()) {
    logger.warn('[serpContactExtractor] LLM not configured — skipping');
    return [];
  }

  const queries = buildQueries(companyName, opts.roleKeywords);

  // Run a single multi-query SERP call. searchMany dedups by URL across queries.
  let results: SearchResultItem[] = [];
  try {
    results = await Promise.race([
      searchMany(queries),
      new Promise<SearchResultItem[]>((_, reject) =>
        setTimeout(() => reject(new Error('serp_timeout')), SERP_TIMEOUT_BUDGET_MS),
      ),
    ]);
  } catch (err) {
    logger.warn('[serpContactExtractor] SERP fetch failed', {
      companyName, err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (results.length === 0) {
    logger.info('[serpContactExtractor] zero SERP results', { companyName });
    return [];
  }

  // Filter out aggregator/junk URLs that produce false positives
  const JUNK_HOSTS = ['apollo.io', 'rocketreach.co', 'zoominfo.com', 'lusha.com', 'signalhire.com', 'contactout.com'];
  const filtered = results.filter((r) => {
    try {
      const host = new URL(r.url).host.toLowerCase();
      return !JUNK_HOSTS.some((j) => host.includes(j));
    } catch { return true; }
  });

  if (filtered.length === 0) {
    logger.info('[serpContactExtractor] all SERP results filtered as junk', { companyName });
    return [];
  }

  const corpus = buildCorpus(companyName, filtered, opts.personaContext);

  let raw: string;
  try {
    raw = await callLlm({
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: corpus },
      ],
      max_tokens: 800,
      temperature: 0,
      response_format: { type: 'json_object' },
      timeoutMs: 30_000,
    });
  } catch (err) {
    logger.warn('[serpContactExtractor] LLM extraction failed', {
      companyName, err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const json = extractFirstJsonObject(raw);
  if (!json) {
    logger.warn('[serpContactExtractor] LLM returned no JSON', { companyName });
    return [];
  }

  let parsed: SerpExtractedResponse;
  try {
    parsed = JSON.parse(json) as SerpExtractedResponse;
  } catch {
    logger.warn('[serpContactExtractor] invalid JSON from LLM', { companyName });
    return [];
  }

  const contacts = (parsed.contacts ?? [])
    .map((c) => validateContact(c, companyName))
    .filter((c): c is SerpContact => c !== null);

  logger.info('[serpContactExtractor] extraction complete', {
    companyName,
    companyDomain: opts.companyDomain,
    persona: opts.personaContext?.slice(0, 80),
    roleKeywords: opts.roleKeywords,
    snippets: filtered.length,
    contactsFound: contacts.length,
  });

  return contacts;
}
