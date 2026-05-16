import { logger } from '../utils/logger.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';
import { env } from '../config/env.js';
import type { HybridCandidate } from '../pipeline/jobSubagent.js';

/**
 * Post-discovery filter: drops candidates that are household / well-known
 * names when the user's brief explicitly excluded prominent companies.
 *
 * Why a separate pass instead of relying on the discovery prompt:
 *   The discovery prompt has a "COUNTERACT YOUR RETRIEVAL BIAS" rule
 *   asking the model to self-check each candidate for prominence. In
 *   practice, the model still returns major Nigerian businesses (Aiteo,
 *   Lekoil, Forte Oil, Dangote, etc.) on briefs that explicitly excluded
 *   them. The discovery model is rewarded for high-recall and gets the
 *   self-check wrong on borderline cases — it knows Lekoil is "indigenous"
 *   so it codes it as "small", missing that Lekoil is publicly listed on
 *   AIM London with multi-asset operations.
 *
 *   A focused single-purpose pass with one job ("rate prominence")
 *   produces sharper judgments than asking the discovery model to do
 *   double duty during recall.
 *
 * Implementation:
 *   - One batched LLM call covering all candidates.
 *   - Returns yes/no/unknown per candidate.
 *   - Drop the yes-flagged ones; keep no/unknown so we don't over-prune.
 *   - When LLM is unavailable, return all candidates unchanged (fail-open).
 *
 * Cost: ~$0.005 per job. Cheap insurance against the household-name
 * problem that has plagued the previous test runs.
 */

const SYSTEM_PROMPT = `You judge whether companies are "household / well-known names" in the user's target market.

OUTPUT — single JSON object. First character "{", last character "}". No prose.

Schema:
{
  "verdicts": [
    { "name": "<exact candidate name>", "verdict": "household|niche|unknown", "reason": "<one short clause>" }
  ]
}

DEFINITION OF "household":
A company is "household" if any of these is true:
- It is publicly listed on a major exchange (NSE, NGX, AIM London, NYSE, LSE, JSE).
- It is a top-10 player in its sector by revenue, headcount, or market share in the target country.
- It regularly appears in international or major national press (Bloomberg, Reuters, FT, This Day, Punch, BusinessDay).
- It has annual revenue clearly exceeding $50M (USD), or headcount clearly exceeding 1,000.
- It has a Wikipedia entry of substantive length.
- It is a state-owned enterprise, a multinational subsidiary, or a top-3 brand in any major Nigerian sector (oil & gas, banking, telecoms, FMCG, conglomerates).

DEFINITION OF "niche":
A company is "niche" if it is plausibly a single-location, single-asset, single-product, or sub-$10M-revenue operator. Indigenous indies in primary sectors are usually niche EXCEPT when listed on a stock exchange.

DEFINITION OF "unknown":
Use this only when you genuinely have no signal either way (very obscure name).

NIGERIAN-MARKET ANCHORS (these ARE household names, never code as niche):
Aiteo, Lekoil, Oando, Seplat, Forte Oil, Mobil Nigeria, Total Nigeria, Chevron Nigeria, Shell Nigeria, NNPC, NLNG, Dangote (any subsidiary), BUA Group, MTN Nigeria, Globacom, Airtel Nigeria, 9mobile, Access Bank, Zenith Bank, GTBank, First Bank, UBA, Stanbic IBTC, Fidelity Bank, FCMB, Sterling Bank, Wema Bank, Nigerian Breweries, Guinness Nigeria, Cadbury Nigeria, Unilever Nigeria, Nestlé Nigeria, PZ Cussons, Flour Mills of Nigeria, Honeywell Flour Mills, Dufil (Indomie), Coscharis, Heirs Holdings, Transcorp, UAC, Conoil, MRS, Eterna Plc, NBPlc, Capital Oil and Gas (the major one), Bua Cement, Lafarge Africa, Julius Berger, Cappa & D'Alberto, Costain, Setraco, RCCG (organisations), Aliko Dangote Foundation.

When in doubt about whether a Nigerian company crosses the threshold: lean toward "household" rather than "niche". The user explicitly asked to exclude prominent names, so a false-household label costs less than a false-niche label.

RULES:
- Process every input candidate. Same name in same order.
- "name" must match the input candidate's name EXACTLY.
- "reason" must be ONE clause, ≤ 100 chars.
- Empty descriptions/snippets are fine — judge from the name + your knowledge.`;

interface VerdictRaw {
  name?: string;
  verdict?: string;
  reason?: string;
}

interface VerdictsRoot {
  verdicts?: VerdictRaw[];
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

export interface HouseholdFilterResult {
  kept: HybridCandidate[];
  dropped: Array<{ candidate: HybridCandidate; reason: string }>;
  /** True when the LLM call failed and we returned the input unchanged. */
  failedOpen: boolean;
}

/**
 * Filters out household / well-known names from a candidate set.
 *
 * Returns the candidates unchanged when:
 *   - LLM is not configured (no API key), or
 *   - The LLM call throws (rate limit, timeout, etc.)
 *
 * Both fail-open paths are deliberate: a missing filter is preferable
 * to dropping the entire candidate set when the model isn't reachable.
 */
export async function filterHouseholdNames(
  candidates: HybridCandidate[],
  countryHint: string,
): Promise<HouseholdFilterResult> {
  if (candidates.length === 0) return { kept: [], dropped: [], failedOpen: false };
  if (!isLlmConfigured()) {
    logger.warn('[householdNameFilter] LLM not configured — skipping');
    return { kept: candidates, dropped: [], failedOpen: true };
  }

  const corpus = `TARGET MARKET: ${countryHint || 'Nigeria'}\n\nCANDIDATES:\n` +
    candidates.map((c, i) => `${i + 1}. ${c.name}${c.domain ? ` (${c.domain})` : ''}${c.description ? ` — ${c.description.slice(0, 200)}` : ''}`).join('\n');

  let raw: string;
  try {
    raw = await callLlm({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: corpus },
      ],
      max_tokens: Math.min(2000, 100 + candidates.length * 60),
      temperature: 0,
      response_format: { type: 'json_object' },
      timeoutMs: 30_000,
      // Use the judgment model when available — same family as the
      // intent parser, which already handles this kind of "small vs
      // large" reasoning correctly.
      ...(!env.USE_LOCAL_LLM && env.JUDGMENT_LLM_MODEL
        ? { model: env.JUDGMENT_LLM_MODEL }
        : {}),
    });
  } catch (err) {
    logger.warn('[householdNameFilter] LLM call failed — keeping all candidates', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { kept: candidates, dropped: [], failedOpen: true };
  }

  const json = extractFirstJsonObject(raw);
  if (!json) {
    logger.warn('[householdNameFilter] LLM returned no JSON — keeping all candidates');
    return { kept: candidates, dropped: [], failedOpen: true };
  }

  let parsed: VerdictsRoot;
  try {
    parsed = JSON.parse(json) as VerdictsRoot;
  } catch {
    logger.warn('[householdNameFilter] invalid JSON — keeping all candidates');
    return { kept: candidates, dropped: [], failedOpen: true };
  }

  const verdicts = parsed.verdicts ?? [];
  const verdictByName = new Map<string, VerdictRaw>();
  for (const v of verdicts) {
    if (typeof v?.name === 'string') {
      verdictByName.set(v.name.trim().toLowerCase(), v);
    }
  }

  const kept: HybridCandidate[] = [];
  const dropped: Array<{ candidate: HybridCandidate; reason: string }> = [];
  for (const c of candidates) {
    const v = verdictByName.get(c.name.trim().toLowerCase());
    if (v?.verdict === 'household') {
      dropped.push({ candidate: c, reason: v.reason ?? 'flagged household-name' });
    } else {
      kept.push(c); // niche / unknown / no verdict found = keep
    }
  }

  logger.info('[householdNameFilter] complete', {
    input: candidates.length,
    kept: kept.length,
    dropped: dropped.length,
    dropped_names: dropped.map((d) => d.candidate.name),
  });

  return { kept, dropped, failedOpen: false };
}
