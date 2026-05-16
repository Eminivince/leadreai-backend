import { logger } from '../utils/logger.js';
import { SUBAGENT_TOOLS, executeTool, renderToolMenu, type ToolContext } from './tools/index.js';
import type { Candidate } from './tools/index.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';
import type { LeadRecord } from './deduplicator.js';
import type { ParsedIntent } from '../../shared/index.js';
import { Redis } from 'ioredis';

export interface ProspectingSubagentJobData {
  parentJobId: string;
  workspaceId: string;
  candidate: Candidate;
  parsedIntent: ParsedIntent;
  rawQuery?: string;
  clarifications?: Array<{ id: string; question: string; answer: unknown }>;
  budget: { maxSteps: number; wallClockMs: number };
  /** Set to 'hybrid' when this job was dispatched by the hybrid discovery pipeline.
   *  The worker uses this to call enrichKnownCompany instead of runSubagent. */
  mode?: 'standard' | 'hybrid';
  /** Populated only when mode === 'hybrid'. Contains the full structured candidate
   *  from the discovery LLM call, including fitReason and signals. */
  hybridCandidate?: HybridCandidate;
}

/** A candidate produced by the hybrid discovery pipeline. May come from
 *  LLM recall (training data) OR directory-based extraction (open web).
 *  Domain is optional — directory entries often arrive name-only and the
 *  subagent finds the domain via search downstream. */
export interface HybridCandidate {
  name: string;
  /** Root domain only, no protocol, no path. Empty string when unknown
   *  (e.g. directory-sourced candidates that didn't ship a domain in the
   *  snippet). The subagent searches for a real footprint when empty. */
  domain: string;
  /** One factual sentence describing the company. */
  description: string;
  /** 2-3 sentences explaining why this company fits the user's offering.
   *  References concrete attributes — not generic "industry leader" copy. */
  fitReason: string;
  confidence: 'high' | 'medium' | 'low';
  /** 1-3 short signal tags e.g. "Series A", "50-200 staff", "rapid hiring". */
  signals: string[];
  /** Set when the domain is missing OR validateCandidates couldn't resolve
   *  it via DNS. The subagent should treat the domain as a hint at best
   *  and search-discover a real footprint (social, registry, alt domain). */
  domainUnverified?: boolean;
  /** Optional: LLM may name a likely founder/CEO/owner during discovery
   *  when it's confident from training data. Used by the subagent and
   *  contact pipeline to skip rediscovery for well-known companies. The
   *  subagent MUST verify the name (e.g. via SERP cross-check) before
   *  promoting it to a contact — discovery's confidence is not enough. */
  likelyContact?: {
    name: string;
    title?: string;
    sourceHint?: string;
  };
  /** Phones already known at discovery time (e.g. Google Maps Place
   *  Details, Nairaland forum posts). The subagent attaches these to
   *  the lead at write time so they don't get lost when the agent's
   *  own search comes up empty for the company. */
  seedPhones?: string[];
  /** Emails already known at discovery time. Same shape as seedPhones —
   *  surfaces structured contact data from sources that ship it. */
  seedEmails?: string[];
  /** Address known at discovery time (Maps Place Details). Captured for
   *  the lead record's address field. */
  seedAddress?: string;
}

export interface SubagentResult {
  leads: LeadRecord[];
  stepsUsed: number;
}

const LLM_TIMEOUT_MS = 45_000;
type HistoryMsg = { role: 'system' | 'user' | 'assistant'; content: string };

function buildSubagentSystemPrompt(maxSteps: number, wallClockMs: number): string {
  return `You are an ENRICHMENT SUBAGENT for a B2B prospecting system.

You have been assigned ONE company to research. Your MANDATORY output: call write_lead at least once. A company name + domain with no email is still a valid lead. Returning 0 leads is always a failure.

## Available tools

${renderToolMenu(SUBAGENT_TOOLS)}

## Response format (strict JSON, no markdown)

  {"thought": "…", "tool": "<name>", "args": {…}}   — call a tool
  {"done": true, "summary": "…"}                      — ONLY after write_lead has been called

## Mandatory enrichment sequence

### STEP 1 — Write baseline immediately (REQUIRED, do this first)
Call write_lead with company name + domain + empty emails array. This is non-negotiable.
Do NOT skip this step waiting for an email. The lead exists; commit it now.

### STEP 2 — Hunt for the homepage and team/about pages
Try fetch_url on the homepage. If that fails or times out, try scrape_page.
Then try fetch_url on: /team, /about, /about-us, /leadership, /people, /management, /contact, /company.
Extract any visible emails, phones, or names.

### STEP 3 — Search for decision-makers when website is thin
Use search_web with targeted queries:
  - "{company} CEO linkedin"
  - "site:linkedin.com/in {company}"
  - "{company} founder OR CEO OR director Nigeria email"
  - "{company} @{domain}" (finds email mentions on the web)
Use extract_names_from_urls on any aggregator/LinkedIn URLs returned.

### STEP 4 — Permute and verify every name you find
For EVERY name discovered (from team page, LinkedIn SERP, anywhere):
  a. Call permute_email with domain + firstName + lastName
  b. Call verify_email on each permutation — stop at first "likely_valid" result
  c. A "likely_valid" verdict means: use that email

### STEP 5 — Upgrade the baseline lead
Call write_lead again with the named contact + verified email to upgrade the baseline.

## Hard rules

- You enrich ONE company. Do not discover new companies.
- Budget: ${maxSteps} steps, ${Math.round(wallClockMs / 1000)} s.
- NEVER call {"done":true} without having called write_lead at least once.
- If the website is completely unreachable, still write the baseline lead and use search_web to find names.
- Do NOT call list_companies, lookup_registry, search_workspace_leads, or queue_company.`;
}

function buildSubagentUserPrompt(data: ProspectingSubagentJobData): string {
  const { candidate, parsedIntent, rawQuery } = data;
  const parts: string[] = [
    `Target company: ${candidate.companyName}`,
  ];
  if (candidate.companyDomain) parts.push(`Domain: ${candidate.companyDomain}`);
  if (candidate.hints.length) parts.push(`Hints from dispatcher:\n${candidate.hints.map(h => `  - ${h}`).join('\n')}`);
  if (rawQuery) parts.push(`Original query context: "${rawQuery}"`);
  parts.push(
    `Industry: ${parsedIntent.industry ?? 'any'}`,
    `Desired fields: ${parsedIntent.desiredFields.join(', ') || 'standard contact data'}`,
  );
  const schema = parsedIntent.outputSchema ?? [];
  if (schema.length > 0) {
    parts.push(`Extra columns to fill via write_lead \`facts\`:`);
    for (const col of schema) {
      parts.push(`  - ${col.key} (${col.type}): "${col.label}"`);
    }
  }
  return parts.join('\n');
}

async function callLLM(history: HistoryMsg[]): Promise<string> {
  return callLlm({
    messages: history,
    max_tokens: 1000,
    temperature: 0,
    response_format: { type: 'json_object' },
    timeoutMs: LLM_TIMEOUT_MS,
  });
}

export async function runSubagent(
  data: ProspectingSubagentJobData,
  publisher: Redis,
): Promise<SubagentResult> {
  const { parentJobId, workspaceId, parsedIntent, budget } = data;
  const { maxSteps, wallClockMs } = budget;

  if (!isLlmConfigured()) {
    logger.error('[subagent] LLM not configured', { parentJobId });
    return { leads: [], stepsUsed: 0 };
  }

  // Subagents write to parentJobId so leads appear in the parent's result list.
  const ctx: ToolContext = {
    jobId: parentJobId,
    workspaceId,
    publisher,
    parsedIntent,
    leadsSoFar: [],
    pagesScrapedThisJob: new Set<string>(),
  };

  const history: HistoryMsg[] = [
    { role: 'system', content: buildSubagentSystemPrompt(maxSteps, wallClockMs) },
    { role: 'user', content: buildSubagentUserPrompt(data) },
  ];

  const startedAt = Date.now();
  let stepsUsed = 0;

  for (let step = 0; step < maxSteps; step++) {
    // Exit early once we've written at least one lead and had a few steps to upgrade it.
    if (ctx.leadsSoFar.length > 0 && step > 5) break;
    if (Date.now() - startedAt > wallClockMs) break;

    let raw: string;
    try {
      raw = await callLLM(history);
      stepsUsed = step + 1;  // only count iterations where an LLM call was made
    } catch (err) {
      logger.warn('[subagent] LLM call failed', {
        parentJobId,
        step,
        company: data.candidate.companyName,
        err: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    history.push({ role: 'assistant', content: raw });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (parsed?.done === true) break;

    const toolName: string | undefined = parsed?.tool;
    if (!toolName) {
      history.push({ role: 'user', content: 'Respond with a JSON tool call or {"done":true}.' });
      continue;
    }

    const result = await executeTool(toolName, parsed.args ?? {}, ctx, SUBAGENT_TOOLS);
    history.push({ role: 'user', content: `Tool ${toolName} result (ok=${result.ok}):\n${result.output}` });
  }

  logger.info('[subagent] finished', {
    parentJobId,
    company: data.candidate.companyName,
    leads: ctx.leadsSoFar.length,
    stepsUsed,
  });
  return { leads: ctx.leadsSoFar, stepsUsed };
}

// ── Hybrid entry point ────────────────────────────────────────────────────────
// Same enrichment loop as runSubagent but receives a fully validated HybridCandidate
// instead of a dispatcher-sourced Candidate. The user prompt is richer (description +
// fitReason + signals), and the system prompt explicitly skips domain discovery since
// the domain is already confirmed.

function buildHybridSubagentUserPrompt(
  data: ProspectingSubagentJobData & { hybridCandidate: HybridCandidate },
): string {
  const { hybridCandidate, parsedIntent, rawQuery } = data;
  const parts: string[] = [
    `Target company: ${hybridCandidate.name}`,
  ];
  if (hybridCandidate.domain) {
    parts.push(`Domain: ${hybridCandidate.domain}  ← ${hybridCandidate.domainUnverified ? 'unverified — search for real footprint' : 'confirmed valid via DNS + HTTP'}`);
  } else {
    parts.push(`Domain: (none — small SME with no website; search by company name for any web/social presence)`);
  }
  parts.push(
    ``,
    `About this company: ${hybridCandidate.description}`,
    `Why they fit: ${hybridCandidate.fitReason}`,
    `Signals: ${hybridCandidate.signals.join(', ')}`,
  );

  // Seed contacts — when discovery already returned phones/emails (Maps,
  // Nairaland), tell the agent so it doesn't waste budget rediscovering
  // them. The agent should call write_lead with these immediately.
  if (hybridCandidate.seedPhones && hybridCandidate.seedPhones.length > 0) {
    parts.push(``, `KNOWN PHONES (already verified by discovery — include these in write_lead): ${hybridCandidate.seedPhones.join(', ')}`);
  }
  if (hybridCandidate.seedEmails && hybridCandidate.seedEmails.length > 0) {
    parts.push(`KNOWN EMAILS (already verified by discovery — include these in write_lead): ${hybridCandidate.seedEmails.join(', ')}`);
  }
  if (hybridCandidate.seedAddress) {
    parts.push(`KNOWN ADDRESS: ${hybridCandidate.seedAddress}`);
  }

  if (rawQuery) parts.push(``, `Original query: "${rawQuery}"`);
  parts.push(
    `Industry: ${parsedIntent.industry ?? 'any'}`,
    `Desired fields: ${parsedIntent.desiredFields.join(', ') || 'standard contact data'}`,
  );
  const schema = parsedIntent.outputSchema ?? [];
  if (schema.length > 0) {
    parts.push(`Extra columns to fill via write_lead \`facts\`:`);
    for (const col of schema) {
      parts.push(`  - ${col.key} (${col.type}): "${col.label}"`);
    }
  }
  return parts.join('\n');
}

/**
 * Enrichment entry point for the hybrid discovery pipeline.
 * Receives a known, DNS-validated company — skips all domain discovery work
 * and goes straight to contact extraction → email verification → lead write.
 *
 * Shares the same enrichment loop and tool set as runSubagent. The only
 * difference is the richer user prompt (description, fitReason, signals)
 * which helps the subagent skip generic homepage hunting and focus on
 * decision-maker extraction from the first step.
 */
export async function enrichKnownCompany(
  data: ProspectingSubagentJobData & { hybridCandidate: HybridCandidate },
  publisher: Redis,
): Promise<SubagentResult> {
  const { parentJobId, workspaceId, parsedIntent, budget } = data;
  const { name, domain } = data.hybridCandidate;
  const { maxSteps, wallClockMs } = budget;

  if (!isLlmConfigured()) {
    logger.error('[enrichKnownCompany] LLM not configured', { parentJobId, company: name });
    return { leads: [], stepsUsed: 0 };
  }

  const ctx: ToolContext = {
    jobId: parentJobId,
    workspaceId,
    publisher,
    parsedIntent,
    leadsSoFar: [],
    pagesScrapedThisJob: new Set<string>(),
  };

  // System prompt is identical to standard subagent — same tool set, same sequence.
  // The richer user prompt provides enough context that the agent doesn't waste steps
  // on domain discovery it would otherwise do.
  const history: HistoryMsg[] = [
    { role: 'system', content: buildSubagentSystemPrompt(maxSteps, wallClockMs) },
    { role: 'user', content: buildHybridSubagentUserPrompt(data) },
  ];

  const startedAt = Date.now();
  let stepsUsed = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (ctx.leadsSoFar.length > 0 && step > 5) break;
    if (Date.now() - startedAt > wallClockMs) break;

    let raw: string;
    try {
      raw = await callLLM(history);
      stepsUsed = step + 1;
    } catch (err) {
      logger.warn('[enrichKnownCompany] LLM call failed', {
        parentJobId, step, company: name,
        err: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    history.push({ role: 'assistant', content: raw });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (parsed?.done === true) break;

    const toolName: string | undefined = parsed?.tool;
    if (!toolName) {
      history.push({ role: 'user', content: 'Respond with a JSON tool call or {"done":true}.' });
      continue;
    }

    const result = await executeTool(toolName, parsed.args ?? {}, ctx, SUBAGENT_TOOLS);
    history.push({ role: 'user', content: `Tool ${toolName} result (ok=${result.ok}):\n${result.output}` });
  }

  logger.info('[enrichKnownCompany] finished', {
    parentJobId, company: name, domain,
    leads: ctx.leadsSoFar.length, stepsUsed,
  });
  return { leads: ctx.leadsSoFar, stepsUsed };
}
