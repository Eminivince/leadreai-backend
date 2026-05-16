/**
 * Smart Discovery — fast, parallel lead research without multi-round agent loops.
 *
 * Architecture:
 *   1. Build targeted SERP queries from parsed intent, run all in parallel.
 *   2. Extract company names + domains DIRECTLY from search result titles/URLs
 *      (no LLM needed — titles like "Cowrywise - Smart Savings" already tell us).
 *   3. ONE small LLM call: "here are 20 company names — who's the CEO/founder?"
 *      The model uses training knowledge. Prompt is tiny (~500 tokens).
 *   4. For every contact found, permute + verify emails in parallel.
 *   5. Return LeadRecord[] ready for writeLeads.
 *
 * Typical wall-clock: 10–25 s. Falls back to serial agent if 0 companies found.
 */

import { logger } from '../utils/logger.js';
import { runSerpSearch } from './serpScraper.js';
import { callLlmOnce } from '../utils/llmClient.js';
import { permuteEmail } from './tools/permuteEmail.js';
import { verifyEmail } from './tools/verifyEmail.js';
import type { LeadRecord } from './deduplicator.js';
import type { ParsedIntent } from '../../shared/index.js';

// Domains that are aggregators / social platforms / news — not company websites
const SKIP_DOMAINS = new Set([
  // Social & professional networks
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com',
  // Business intelligence & data brokers
  'crunchbase.com', 'zoominfo.com', 'rocketreach.co', 'apollo.io', 'hunter.io',
  'lusha.com', 'pitchbook.com', 'owler.com', 'comparably.com', 'angellist.com',
  'wellfound.com', 'glassdoor.com', 'indeed.com', 'g2.com', 'capterra.com',
  'ceoemail.com', 'saleshandy.com', 'globaldatabase.com', 'ngcontacts.com',
  'pointtobusinessservices.com', 'alternativeadvert.com', '6000profiles.com',
  'powrbot.com',
  // Startup directories & discovery platforms
  'startupblink.com', 'tracxn.com', 'startuplist.africa', 'fi.co',
  'ycombinator.com', 'f6s.com', 'producthunt.com',
  // News & media
  'bloomberg.com', 'techcrunch.com', 'forbes.com', 'businessinsider.com',
  'reuters.com', 'guardian.com', 'vanguardngr.com', 'punchng.com',
  'businessday.ng', 'techpoint.africa', 'disrupt-africa.com', 'quartz.com',
  'legit.ng', 'premiumtimesng.com', 'nairametrics.com', 'theinfong.com',
  'siliconafrica.org',
  // Document hosting & reference
  'wikipedia.org', 'scribd.com', 'slideshare.net',
]);

// Article-style titles: "Top 21 Leading...", "9 Proven Methods...", "List of...",
// "Best X in Y", etc. These are article pages — the URL domain is the publisher,
// not the target company.
const ARTICLE_TITLE_RE = /^(\d+[\s\xa0]|top \d+|list of|best |leading |how to|proven |guide to|what is|why |when |understand)/i;

function isAggregator(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return SKIP_DOMAINS.has(d) || d.endsWith('.gov.ng') || d.endsWith('.edu.ng');
}

function looksLikeCompanyName(rawTitle: string, extractedName: string): boolean {
  // Article titles that slipped through the separator regex are long
  if (extractedName.length > 55) return false;
  // Titles of article pages start with patterns like "Top 21", "9 Proven", "List of"
  if (ARTICLE_TITLE_RE.test(extractedName)) return false;
  // If the raw title itself had no separator, the whole title becomes the name.
  // Sanity-check: a bare article title without separators (e.g. "Top startups in Nigeria Mar 2026")
  if (ARTICLE_TITLE_RE.test(rawTitle)) return false;
  return true;
}

export interface SmartDiscoveryInput {
  jobId: string;
  workspaceId: string;
  parsedIntent: ParsedIntent;
  rawQuery: string;
  clarifications?: Array<{ id: string; question: string; answer: unknown }>;
}

interface ParsedCompany {
  name: string;
  domain: string;
  sources: string[];
  snippet: string;
}

interface LlmContact {
  domain: string;
  name: string;
  title: string;
}

// ── Step 1: build search queries ────────────────────────────────────────────

// Country → ccTLD mapping for site: operator queries.
const COUNTRY_TLD: Record<string, string> = {
  nigeria: '.ng', ghana: '.gh', kenya: '.ke', 'south africa': '.za',
  egypt: '.eg', ethiopia: '.et', tanzania: '.tz', uganda: '.ug',
  uk: '.uk', 'united kingdom': '.uk', canada: '.ca', australia: '.au',
  india: '.in', brazil: '.br', germany: '.de', france: '.fr',
};

function buildSearchQueries(intent: ParsedIntent, rawQuery: string): string[] {
  const city = intent.geography?.city ?? '';
  const country = intent.geography?.country ?? '';
  const geo = [city, country].filter(Boolean).join(' ');
  const industry = intent.industry ?? '';

  // Use key noun-phrases from the raw query when industry is null
  const topic = industry || rawQuery.split(' ').slice(0, 5).join(' ');

  // Query 1 & 2: target actual company pages, not article pages.
  // "contact us" / "book" / "our services" are page-structure phrases that appear
  // on company websites, not on directory/article pages.
  const queries: string[] = [
    `"${topic}" ${geo} "contact us" OR "about us" CEO founder`,
    `"${topic}" ${geo} company "book" OR "enquire" OR "request a quote" email`,
  ];

  // Query 3: ccTLD-targeted if we recognise the country — returns company homepages
  const tld = COUNTRY_TLD[country.toLowerCase()];
  if (tld) {
    queries.push(`"${topic}" site:${tld} CEO OR founder OR director`);
  } else {
    queries.push(`"${topic}" ${geo} startup OR SME CEO OR founder contact email`);
  }

  const q = rawQuery.toLowerCase();

  // Funding / startup signal
  if (q.includes('series') || q.includes('funded') || q.includes('startup')) {
    queries.push(`"${topic}" ${geo} "Series A" OR "Series B" founders email`);
  }
  // Law / professional services
  if (q.includes('law') || q.includes('legal') || q.includes('firm')) {
    queries.push(`"${topic}" law firm ${geo} "managing partner" contact`);
  }
  // Named entities mentioned by user
  if (intent.namedEntities?.length) {
    queries.push(intent.namedEntities.slice(0, 4).join(' OR ') + ` ${geo} CEO email`);
  }

  return queries.slice(0, 5);
}

// ── Step 2: parse companies from search results (no LLM) ─────────────────────

function parseCompaniesFromResults(
  results: Array<{ url: string; title: string; snippet: string }>,
): ParsedCompany[] {
  const byDomain = new Map<string, ParsedCompany>();

  for (const r of results) {
    let hostname: string;
    try {
      hostname = new URL(r.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }
    if (isAggregator(hostname)) continue;

    if (byDomain.has(hostname)) {
      // Accumulate sources for the same domain
      byDomain.get(hostname)!.sources.push(r.url);
      continue;
    }

    // Extract company name: take the part of the title before " - ", " | ", " – ", " : "
    const name = r.title
      .replace(/\s*[-|–:]\s*.+$/, '')
      .replace(/\s+Ltd\.?$|\s+Inc\.?$|\s+Plc\.?$/i, '')
      .trim();

    if (!name || name.length < 3) continue;
    if (!looksLikeCompanyName(r.title, name)) continue;

    byDomain.set(hostname, {
      name,
      domain: hostname,
      sources: [r.url],
      snippet: r.snippet.slice(0, 200),
    });
  }

  return [...byDomain.values()];
}

// ── Step 3: single small LLM call for contacts ───────────────────────────────

async function getContactsFromLlm(
  companies: ParsedCompany[],
  intent: ParsedIntent,
  rawQuery: string,
): Promise<Map<string, LlmContact>> {
  const persona = intent.desiredFields.join(', ') || 'CEO, founder, or managing director';
  const geo = [intent.geography?.city, intent.geography?.country].filter(Boolean).join(', ') || '';

  const companyList = companies
    .map(c => `${c.name} (${c.domain})`)
    .join('\n');

  const prompt = `You are a B2B research assistant. For each company listed, provide the ${persona}'s full name if you know it from your training data.

Query context: "${rawQuery}"
Geography: ${geo || 'any'}

Companies:
${companyList}

Rules:
- Only include contacts you are highly confident about (publicly known founders/executives).
- Never invent names. Omit companies you are unsure about.
- Return only JSON, no explanation.

{"contacts": [{"domain": "example.com", "name": "First Last", "title": "CEO & Co-founder"}]}`;

  // Single attempt only — contacts are optional. If the free-tier model is
  // overloaded, fail fast and proceed with company-only leads rather than
  // burning 76s of retry backoff on a non-critical lookup.
  let raw: string;
  try {
    const result = await callLlmOnce({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
      temperature: 0,
      response_format: { type: 'json_object' },
      timeoutMs: 30_000,
    });
    if (!result.ok || !result.content) {
      logger.warn('[smartDiscovery] contact LLM non-ok — proceeding without contacts', { status: result.status });
      return new Map();
    }
    raw = result.content;
  } catch (err) {
    logger.warn('[smartDiscovery] contact LLM call threw — proceeding without contacts', {
      err: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(raw) as any;
    const contacts: LlmContact[] = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
    const map = new Map<string, LlmContact>();
    for (const c of contacts) {
      if (c.domain && c.name) map.set(c.domain.toLowerCase().replace(/^www\./, ''), c);
    }
    logger.info('[smartDiscovery] LLM contacts', { found: map.size, of: companies.length });
    return map;
  } catch {
    logger.warn('[smartDiscovery] failed to parse contact LLM response');
    return new Map();
  }
}

// ── Step 4: email verification ───────────────────────────────────────────────

async function findBestEmail(
  domain: string,
  firstName: string,
  lastName: string,
): Promise<{ address: string; confidence: number } | null> {
  const permutations = permuteEmail(domain, firstName, lastName);

  const results = await Promise.allSettled(
    permutations.map(async p => {
      const v = await verifyEmail(p.address);
      return { address: p.address, verdict: v.verdict };
    }),
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.verdict === 'likely_valid') {
      return { address: r.value.address, confidence: 0.85 };
    }
  }
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.verdict === 'risky') {
      return { address: r.value.address, confidence: 0.5 };
    }
  }
  return null;
}

// ── Step 5: assemble LeadRecord ───────────────────────────────────────────────

function inferSeniority(title: string): string {
  const t = title.toLowerCase();
  if (/ceo|chief executive|founder|managing director|managing partner/.test(t)) return 'c_suite';
  if (/cto|coo|cfo|chief /.test(t)) return 'c_suite';
  if (/\bvp\b|vice president|director/.test(t)) return 'vp';
  if (/manager|head of|partner/.test(t)) return 'manager';
  return 'unknown';
}

async function buildLeadRecord(
  company: ParsedCompany,
  contact: LlmContact | undefined,
  input: SmartDiscoveryInput,
): Promise<LeadRecord> {
  const { jobId, workspaceId, parsedIntent } = input;
  const emails: LeadRecord['emails'] = [];
  let contactSummary: LeadRecord['contactSummary'];

  if (contact?.name) {
    const parts = contact.name.trim().split(/\s+/);
    const firstName = parts[0] ?? '';
    const lastName = parts.slice(1).join(' ');

    if (firstName && lastName) {
      const found = await findBestEmail(company.domain, firstName, lastName);
      if (found) {
        emails.push({
          address: found.address,
          type: 'business',
          confidence: found.confidence,
          source: 'permuted_verified',
          name: contact.name,
          title: contact.title,
        });
      }
    }

    contactSummary = {
      totalContacts: 1,
      topContact: {
        fullName: contact.name,
        title: contact.title ?? '',
        seniority: inferSeniority(contact.title ?? ''),
      },
    };
  }

  // Generic email fallback intentionally REMOVED.
  //
  // We used to fall back to `info@${domain}` when no other email was found
  // for a company. That produced a stream of role-based addresses that
  // looked legit but had near-zero reply rate and (worse) torched the
  // agency's sending reputation. Product decision: never surface generic
  // mailboxes as if they were viable contacts. If we couldn't find a real
  // person's email, the lead carries no email — let the user act on
  // phone or domain instead.

  return {
    workspaceId,
    jobId,
    companyName: company.name,
    companyDomain: company.domain,
    website: `https://${company.domain}`,
    industry: parsedIntent.industry ?? undefined,
    address: {
      country: parsedIntent.geography?.country ?? undefined,
      city: parsedIntent.geography?.city ?? undefined,
    },
    emails,
    phones: [],
    sources: company.sources.slice(0, 3).map(url => ({
      url,
      type: 'scraped_page' as const,
      scrapedAt: new Date(),
      confidence: 0.7,
    })),
    rawSnippets: company.snippet ? [company.snippet] : [],
    rankScore: emails.length > 0
      ? (emails[0]!.type === 'business' ? 82 : 52)
      : 38,
    completenessScore: 0,
    isDuplicate: false,
    tags: ['smart_discovery'],
    ...(contactSummary && { contactSummary }),
    osint: { viaSmartDiscovery: true } as Record<string, unknown>,
  };
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runSmartDiscovery(
  input: SmartDiscoveryInput,
): Promise<LeadRecord[]> {
  const { parsedIntent, rawQuery } = input;

  // 1. Parallel searches
  const queries = buildSearchQueries(parsedIntent, rawQuery);
  logger.info('[smartDiscovery] running searches', { queries: queries.length, queryList: queries });

  const searchArrays = await Promise.allSettled(queries.map(q => runSerpSearch([q])));

  const seen = new Set<string>();
  const allResults: Array<{ url: string; title: string; snippet: string }> = [];
  for (const r of searchArrays) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        allResults.push({ url: item.url, title: item.title, snippet: item.snippet });
      }
    }
  }
  logger.info('[smartDiscovery] search complete', { totalResults: allResults.length });

  // 2. Extract companies from search results — no LLM needed
  const companies = parseCompaniesFromResults(allResults);
  if (companies.length === 0) {
    logger.warn('[smartDiscovery] no companies parsed from search results');
    return [];
  }

  const targetCount = parsedIntent.targetCount ?? 20;
  const toProcess = companies.slice(0, Math.min(companies.length, targetCount * 2));
  logger.info('[smartDiscovery] companies parsed', { total: companies.length, processing: toProcess.length });

  // 3. Small LLM call: just get contact names
  const contactMap = await getContactsFromLlm(toProcess, parsedIntent, rawQuery);

  // 4+5. Enrich + verify emails in parallel
  const enriched = await Promise.allSettled(
    toProcess.map(company =>
      buildLeadRecord(company, contactMap.get(company.domain), input),
    ),
  );

  const leads: LeadRecord[] = [];
  for (const r of enriched) {
    if (r.status === 'fulfilled') leads.push(r.value);
    else logger.warn('[smartDiscovery] lead build failed', { err: r.reason });
  }

  leads.sort((a, b) => b.rankScore - a.rankScore);

  logger.info('[smartDiscovery] complete', {
    total: leads.length,
    withBusinessEmail: leads.filter(l => l.emails.some(e => e.type === 'business')).length,
    withGenericEmail: leads.filter(l => l.emails.some(e => e.type === 'generic')).length,
    noEmail: leads.filter(l => l.emails.length === 0).length,
  });

  return leads.slice(0, targetCount);
}
