import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { callLlmOnce, isLlmConfigured } from '../utils/llmClient.js';
import { env } from '../config/env.js';
import type { ParsedIntent } from '../../shared/index.js';

/**
 * Generates a useful, brief-relevant one-sentence reason for each
 * surviving lead. Runs as the final step after writeLeads — once we
 * know which leads actually shipped to the user, one batched LLM call
 * produces per-lead reasoning, written back to lead.agentReasoning.
 *
 * Why this exists:
 *   The reasons that previously populated agentReasoning came from the
 *   subagent's `reasoning` arg on write_lead — typically generic prose
 *   like "Baseline lead with known phone number from Google Maps." That
 *   describes HOW the lead was sourced, not WHY it matches the user's
 *   brief. The reader of the lead drawer wants the latter: "given my
 *   brief was X, why is THIS company in my list?"
 *
 * Design:
 *   - Single LLM call per job (batched).
 *   - Skips leads that already have a high-quality fitReason (the
 *     LLM-recall path produces specific brief-tied fitReasons —
 *     re-running would be redundant).
 *   - Fail-open: an LLM error leaves leads with their existing reason.
 *   - Cost ~$0.005/job.
 */

const SYSTEM_PROMPT = `You are a sales-research assistant. The user submitted a prospecting brief and the system surfaced a list of companies that match. Your job: write ONE concise sentence per company explaining why THIS specific company fits THIS specific brief.

OUTPUT — single JSON object. First character "{", last character "}". No prose.

Schema:
{
  "reasons": [
    { "id": "<exact id from input>", "reason": "<one sentence, ≤30 words>" }
  ]
}

RULES:
1. Reference at least one CONCRETE detail you can see about the company (its name's sector, its location signal, its review count, its likely operations) AND tie it to the user's brief.
2. Don't say generic things like "good fit", "matches your criteria", "promising lead". The user already knows the lead matched — they want to know what about THIS company makes it fit.
3. If the user's brief mentions an offering (e.g. "we sell travel-agency services"), the reason should explain why this company would BUY that offering — not what the company itself does.
4. Don't restate the company name in the reason. Don't restate the user's brief verbatim.
5. Don't say "this company" — start mid-sentence with the relevant detail.
6. Keep to ≤30 words. One sentence. Active voice.
7. If you genuinely have no signal beyond the name, say "Surfaced from <source>; specific fit signals limited — recommend manual review." Don't fabricate.

GOOD examples (for a brief like "find Nigerian corporates that need travel-agency services"):
  "Indigenous oil & gas operator with field crews rotating between Lagos HQ and Niger Delta sites — corporate flight bookings are a recurring spend."
  "Lagos-based management consulting firm; partners frequently fly to client sites and conferences, fitting the corporate-travel buyer profile."
  "Construction contractor with Maps presence in Lagos — site visits across regions imply regular travel needs."

BAD examples (don't write these):
  "This is a good fit for your brief." — generic
  "Pinnacle Oil & Gas is an oil and gas company that matches your search." — restates name, no specifics
  "Listed on Google Maps." — describes sourcing, not fit
  "Match score 0.85 indicates strong relevance." — opaque, no concrete signal`;

interface ReasonEntry {
  id?: string;
  reason?: string;
}

interface ReasonsRoot {
  reasons?: ReasonEntry[];
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

interface LeadForReasoning {
  _id: mongoose.Types.ObjectId | string;
  companyName?: string;
  companyDomain?: string;
  fitReason?: string;
  signals?: string[];
  agentReasoning?: string;
  emails?: Array<{ address: string }>;
  phones?: unknown[];
  contactSummary?: { totalContacts?: number; topContact?: { fullName?: string; title?: string } };
  address?: { city?: string; state?: string; country?: string };
}

/**
 * One sentence per lead, written back to lead.agentReasoning.
 *
 * The previous agentReasoning is OVERWRITTEN — it was generic anyway.
 * The fitReason on the lead is preserved (separate field, used elsewhere
 * for ranking signals).
 */
export async function generateLeadReasons(
  rawQuery: string,
  parsedIntent: ParsedIntent | null | undefined,
  leads: LeadForReasoning[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LeadModel: mongoose.Model<any>,
): Promise<{ updated: number; failedOpen: boolean }> {
  if (leads.length === 0) return { updated: 0, failedOpen: false };
  if (!isLlmConfigured()) {
    logger.warn('[leadReasoner] LLM not configured — skipping');
    return { updated: 0, failedOpen: true };
  }

  // Build the corpus: brief + per-lead context block. Keep it tight.
  const briefBlock: string[] = [`USER BRIEF: "${rawQuery.slice(0, 600)}"`];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userOffering = (parsedIntent as any)?.userOffering as string | undefined;
  if (userOffering) {
    briefBlock.push(`USER IS SELLING: ${userOffering}`);
    briefBlock.push(`(So the leads should be COMPANIES THAT WOULD BUY this — explain why each is a likely buyer.)`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buyerIndustries = (parsedIntent as any)?.targetBuyerIndustries as string[] | undefined;
  if (buyerIndustries?.length) {
    briefBlock.push(`TARGET BUYER INDUSTRIES: ${buyerIndustries.slice(0, 7).join(', ')}`);
  }
  if (parsedIntent?.industry) {
    briefBlock.push(`TARGET INDUSTRY: ${parsedIntent.industry}${parsedIntent.subIndustry ? ` / ${parsedIntent.subIndustry}` : ''}`);
  }
  const geo = [parsedIntent?.geography?.city, parsedIntent?.geography?.state, parsedIntent?.geography?.country].filter(Boolean).join(', ');
  if (geo) briefBlock.push(`GEOGRAPHY: ${geo}`);

  const leadLines: string[] = [];
  for (const l of leads) {
    const id = String(l._id);
    const name = l.companyName ?? '(unnamed)';
    const domain = l.companyDomain ? ` · ${l.companyDomain}` : '';
    const reviewSignal = (l.signals ?? []).find((s) => /★/.test(s)) ?? '';
    const sectorTags = (l.signals ?? []).filter((s) => !/★/.test(s) && !/^google_maps$/i.test(s) && !/^agent_/i.test(s) && !/^source:/i.test(s) && !/^directory:/i.test(s) && !/^nairaland/i.test(s)).slice(0, 4);
    const tagBlock = sectorTags.length ? ` · tags: ${sectorTags.join(',')}` : '';
    const reviewBlock = reviewSignal ? ` · ${reviewSignal}` : '';
    const emails = l.emails?.length ?? 0;
    const phones = (l.phones?.length ?? 0);
    const contactBlock = `emails:${emails} phones:${phones}`;
    const fr = l.fitReason ? ` · fitReason: "${l.fitReason.slice(0, 240)}"` : '';
    const addr = l.address?.city ? ` · ${[l.address.city, l.address.country].filter(Boolean).join(', ')}` : '';
    leadLines.push(`[${id}] ${name}${domain}${tagBlock}${reviewBlock} · ${contactBlock}${addr}${fr}`);
  }

  const userMessage = [briefBlock.join('\n'), '', 'COMPANIES TO REASON ABOUT:', leadLines.join('\n')].join('\n');

  // Two-stage attempt: first try the judgment model (v4-pro), fall back to
  // the default OpenRouter model (v3) on empty content or server error.
  // v4-pro on OpenRouter occasionally returns 200 OK with no body when the
  // upstream provider is overloaded — this fallback turns that transient
  // hiccup into a successful pass instead of dropping reasons entirely.
  const baseRequest = {
    messages: [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: userMessage },
    ],
    max_tokens: Math.min(2400, 200 + leads.length * 100),
    temperature: 0,
    response_format: { type: 'json_object' as const },
    // 60s — v4-pro routinely takes 25-40s on this kind of structured-
    // judgment task, and the previous 35s ceiling was tripping aborts.
    timeoutMs: 60_000,
  };

  let result = await callLlmOnce({
    ...baseRequest,
    ...(!env.USE_LOCAL_LLM && env.JUDGMENT_LLM_MODEL
      ? { model: env.JUDGMENT_LLM_MODEL }
      : {}),
  });

  const isEmpty = result.ok && !result.content;
  const isServerError = !result.ok && result.status >= 500;
  if ((isEmpty || isServerError) && env.JUDGMENT_LLM_MODEL) {
    logger.warn('[leadReasoner] judgment model returned empty/5xx — falling back', {
      status: result.status, empty: isEmpty,
    });
    result = await callLlmOnce(baseRequest);
  }

  if (!result.ok || !result.content) {
    logger.warn('[leadReasoner] LLM call failed', {
      status: result.status, contentLen: result.content?.length ?? 0,
    });
    return { updated: 0, failedOpen: true };
  }
  const raw = result.content;

  const json = extractFirstJsonObject(raw);
  if (!json) {
    logger.warn('[leadReasoner] no JSON in LLM response', {
      contentLen: raw.length,
      preview: raw.slice(0, 200),
    });
    return { updated: 0, failedOpen: true };
  }

  let parsed: ReasonsRoot;
  try {
    parsed = JSON.parse(json) as ReasonsRoot;
  } catch {
    logger.warn('[leadReasoner] invalid JSON');
    return { updated: 0, failedOpen: true };
  }

  const reasons = parsed.reasons ?? [];
  const reasonById = new Map<string, string>();
  for (const r of reasons) {
    if (typeof r?.id === 'string' && typeof r?.reason === 'string' && r.reason.trim()) {
      reasonById.set(r.id.trim(), r.reason.trim().slice(0, 400));
    }
  }

  // Bulk-update reasons in Mongo. updateOne ops keep this atomic per lead.
  const ops: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
    };
  }> = [];
  for (const l of leads) {
    const reason = reasonById.get(String(l._id));
    if (!reason) continue;
    ops.push({
      updateOne: {
        filter: { _id: l._id },
        update: { $set: { agentReasoning: reason } },
      },
    });
  }

  if (ops.length === 0) {
    logger.info('[leadReasoner] complete (no reasons emitted)', { leads: leads.length });
    return { updated: 0, failedOpen: false };
  }

  await LeadModel.bulkWrite(ops, { ordered: false });
  logger.info('[leadReasoner] complete', {
    leads: leads.length,
    reasoned: ops.length,
    skipped: leads.length - ops.length,
  });
  return { updated: ops.length, failedOpen: false };
}
