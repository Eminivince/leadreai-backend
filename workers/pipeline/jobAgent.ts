import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { logger } from '../utils/logger.js';
import type { ParsedIntent } from '../../shared/index.js';
import type { LeadRecord } from './deduplicator.js';
import {
  TOOL_REGISTRY, executeTool, renderToolMenu,
  type ToolContext,
} from './tools/index.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';
import { estimateWallClockMs } from './wallClockBudget.js';
import { jobActivity } from './intentParser.js';
import { runDispatcherAgent } from './jobDispatcher.js';
import type { ProspectingSubagentJobData } from './jobSubagent.js';
import { env } from '../config/env.js';
import { writeLeads } from './leadWriter.js';
import { rankLeads } from './ranker.js';
import { runSmartDiscovery } from './smartDiscovery.js';
import { runHybridDiscovery } from '../discovery/hybridDiscovery.js';

export interface JobAgentInput {
  jobId: string;
  workspaceId: string;
  parsedIntent: ParsedIntent;
  /** Raw natural-language query as typed by the user. Passed verbatim to the
   * agent so constraint phrases ("outside blue-chip names", "not B2C", etc.)
   * that the parser discarded still influence decisions. */
  rawQuery?: string;
  /** User answers to the clarifier checklist. Format: {id, question, answer}.
   * Surfaced verbatim in the initial agent prompt so free-text excludes /
   * custom personas / nuances the parser couldn't map are honored. */
  clarifications?: Array<{ id: string; question: string; answer: unknown }>;
  publisher: Redis;
}

export interface JobAgentResult {
  leads: LeadRecord[];
  stepsUsed: number;
  stopReason: 'target_reached' | 'max_steps' | 'wall_clock' | 'agent_done' | 'error';
  transcript: string[];
  /** True when fan-out path handled its own writeLeads + lifecycle.
   *  intentParser.ts skips its write step when this is set. */
  fanOutComplete?: boolean;
  /** Actual leads found — set by fan-out path. Serial path uses ranked.length. */
  leadsFound?: number;
  /** When true, runJobAgent should retry with the next pipeline (fan-out).
   *  Set by hybrid discovery when the LLM returns 0 usable candidates. */
  fallbackToOld?: boolean;
}

// Step budget scales linearly with target count (min 100, max 300) — large
// demographic jobs need many more tool calls than a single contact_lookup.
// Raised floor from 30 to 100 after observing small-target jobs (e.g. the
// funding e2e with targetCount=5) run out at 50 while still productively
// enriching.
const BASE_MAX_STEPS = 100;
const STEPS_PER_LEAD = 4;
const ABSOLUTE_MAX_STEPS = 300;
// 45s per-call timeout. Complex prompts with full chat history occasionally
// exceed 25s; a tight timeout compounds into whole-job failures (one abort
// ends the agent loop).
const LLM_TIMEOUT_MS = 45_000;
const CRITIC_INTERVAL = 5;

type HistoryMsg = { role: 'system' | 'user' | 'assistant'; content: string };

const SUBAGENT_QUEUE_PREFIX = `{bull}:leadreai:${env.NODE_ENV}`;

/** Poll timeout for the fan-out gather phase. Subagents run in parallel so
 *  this is a ceiling, not per-lead. 90 s per subagent + 60 s dispatcher slack. */
const FAN_OUT_GATHER_TIMEOUT_MS = 150_000;

// Lazy subagent queue — created once per process.
let _subagentQueue: Queue | null = null;
function getSubagentQueue(): Queue {
  if (!_subagentQueue) {
    _subagentQueue = new Queue('prospecting-subagent', {
      connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
      prefix: SUBAGENT_QUEUE_PREFIX,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 50 } },
    });
  }
  return _subagentQueue;
}

// Minimal inline Lead model for polling. strict:false — only reads count.
const _pollLeadSchema = new mongoose.Schema({}, { strict: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PollLeadModel: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', _pollLeadSchema, 'leads');

async function countLeadsForJob(jobId: string): Promise<number> {
  return PollLeadModel.countDocuments({
    jobId: new mongoose.Types.ObjectId(jobId),
    isDuplicate: { $ne: true },
  });
}

async function queryLeadsForJob(jobId: string): Promise<LeadRecord[]> {
  const docs = await PollLeadModel.find({
    jobId: new mongoose.Types.ObjectId(jobId),
    isDuplicate: { $ne: true },
  }).lean();
  return docs as unknown as LeadRecord[];
}

// Inline ProspectingJob model for updating subagentStats.dispatched.
const _pjSchema = new mongoose.Schema({}, { strict: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PJModel: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['ProspectingJob'] as mongoose.Model<any> | undefined) ??
  mongoose.model('ProspectingJob', _pjSchema, 'prospectingjobs');

async function updateDispatchedCount(jobId: string, count: number): Promise<void> {
  await PJModel.findByIdAndUpdate(jobId, {
    $set: { 'subagentStats.dispatched': count },
  }).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildSystemPrompt(maxSteps: number, budgetMs: number): string {
  return `You are an autonomous lead-research agent. Given a user query, you drive a tool-using research process that ends with one or more qualified leads written via the write_lead tool.

## Available tools

${renderToolMenu()}

## Response format

On every turn, respond with EXACTLY ONE JSON object matching one of these shapes (no markdown, no prose, no code fences):

  { "thought": "…", "tool": "<tool_name>", "args": {…} }
    → Call one tool. Thought is private (for your own reasoning).

  { "thought": "…", "done": true, "summary": "…" }
    → Stop. Use when you have already written enough leads via write_lead, or when further work is futile.

## Core strategy

1. PLAN briefly before your first action. What does the user want? How many? **What PERSONAS does the query specify** (founder, CEO, managing partner, head of X, CTO, procurement, etc.)? Persona match is as important as company match. **ALSO re-read the original query for exclusion constraints** ("outside blue-chip", "not B2C", "excluding X") — these MUST be honored; encode them as tags when you call list_companies.

2. **REUSE-FIRST, DISCOVERY-SECOND, SEARCH-THIRD.** For any listing/demographic query (e.g. "top 50 fintechs in Nigeria", "100 law firms in Nigeria"):
   a. Call \`search_workspace_leads\` FIRST with the industry + country. This workspace may have already researched some or all of the targets in prior jobs — reusing is free. If it returns a meaningful pool (>= half the target count), go straight to write_lead / verification on those and skip ahead.
   b. If workspace reuse is thin, call \`list_companies\` with the same industry + country. Registry-sourced known companies with high-confidence domains — usually dozens at once.
   c. Only use \`search_web\` when the first two return too few or the query is too niche.
   This ordering can eliminate 50-80% of SERP calls per job. If the user's query excludes certain categories (e.g. "outside blue-chip"), pass tags:["mid-tier"] or tags:["startup"] to filter at the source.

3. Cheap first (after list_companies): lookup_registry, search_web, fetch_url, extract_names_from_urls, verify_email — these are fast & low-cost. Exhaust these before scrape_page (heavy, uses full browser).

4. **TWO-PASS STRATEGY — write baseline first, upgrade later.** Per company:

   PASS 1 (baseline — always do this first):
   a. Identify the company's real domain (via search_web snippets; don't guess).
   b. The initial search usually surfaces a generic email (info@, contact@, enquiries@) + phone in the snippets or homepage. If you have { domain + any email } already from a search, **call write_lead IMMEDIATELY with that baseline data**. Do NOT do further work before writing. This locks in progress even if you get rate-limited later.
   c. If the initial search didn't surface an email, do ONE fetch_url on the homepage to get one — then write_lead.

   PASS 2 (upgrade — only after baseline is written, and only if budget allows):
   d. For queries asking for named decision-makers, search for the company's leadership/team page ("<domain> partners" / "<company> managing partner" / "<domain> team").
   e. fetch_url the leadership page. Extract named contacts matching the target persona.
   f. Generate + verify a permuted email for that person.
   g. Call write_lead AGAIN with the same companyDomain and the named person's data. The tool upserts on domain and keeps the strictly-better record (named > generic).
   h. If no named person surfaces after ONE team-page attempt, move on — the baseline is already written.

5. For demographic queries ("find 50 <role> at <industry> in <geo>"): apply the reuse-first order from rule 2 (search_workspace_leads → list_companies → search_web). Apply steps 4a-c per company (write baseline), then 4d-g if budget allows.

6. **NEVER end a turn without writing gathered data.** If you've identified a company and any contact path, write_lead before your next tool call. Unwritten intermediate state is lost on errors.

7. Never fabricate data. Only write_lead records you can justify from tool output you've seen. **Never invent a person's name from thin air** — if a team page gives you "John Smith, Managing Partner", use that exactly; don't pattern-match "John Smith" onto a different firm.

8. Reject UI/navigation text as contact names. If the only candidate name on a page is something like "Related Pages", "Our Team", "About Us", "Home", "Contact" — that's page chrome, not a person. Do NOT write it as topContact.

9. Watch your budget (${maxSteps} tool calls, ${Math.round(budgetMs / 1000)}s wall-clock). Prefer cheap tools. Don't scrape aggregator domains (zoominfo.com, rocketreach.co, contactout.com, signalhire.com, datanyze.com, apollo.io, hunter.io, lusha.com) — they're paywalled junk; use extract_names_from_urls on their SERP URLs instead.

10. **WORKSPACE LIBRARY — read_document.** Before running searches, ALWAYS call \`read_document\` with a short query derived from the user's prompt. Their Library holds pitch decks, portfolio lists, ICP notes, and prior research they uploaded — if any of that grounds the current query (e.g. "find companies like my portfolio", "similar to the ones in my ICP doc", or even just matching the industry/geo in their pitch deck), cite the hits in your reasoning and let them shape what you search for next. If the Library is empty, read_document returns hits:[] — move on. This is FIRST because Library context dramatically lowers the number of SERP calls you'll need.

11. **AUDIO INTERVIEWS — transcribe_url.** When the query references founder interviews, podcasts, conference talks, or "who said X on Y" topics, and you have a direct audio/video URL (RSS MP3, M4A, MP4, WAV), call \`transcribe_url\` to get the full text. The transcript caches the same way fetch_file does — use get_file_chunk to page through long episodes. Great for sourcing quotes, executive names, and context that never makes it to text press releases. Direct URLs only — YouTube/Spotify are not yet wired.

12. **FILETYPE DORKS + fetch_file.** When the query maps to a document that likely exists in the wild — attendee lists, annual reports, pitch decks, investor updates, conference proceedings, regulatory filings, CSV data dumps — combine \`search_web\` with filetype operators and pipe the result through \`fetch_file\`:

    · \`filetype:pdf "annual report" 2024 "Nigeria" "fintech"\` → download & parse PDF → extract named executives, revenue, funding
    · \`filetype:xlsx site:cac.gov.ng\` → parse registry spreadsheets as structured tables
    · \`filetype:csv "attendee list" "GITEX Africa"\` → 400 contacts already tabulated
    · \`filetype:pdf "investor letter" "portfolio companies"\` → fund's portfolio roster
    · \`filetype:pptx "pitch deck"\` (PPTX not yet supported; PDF export of same deck is)

    \`fetch_file\` returns a cacheKey + chunk 0 preview + extracted emails/phones/tables. For long PDFs use \`get_file_chunk(cacheKey, idx)\` to page through — do NOT re-download. Cached 24h so repeated reads of the same file are free. The tool also OCRs scanned PDFs automatically (slower, gated to files < 12MB).

## Completion criteria

You must stop when either:
- You have written \`targetCount\` leads via write_lead, OR
- No further productive action remains (emit done:true)

Return ONLY JSON. No markdown fences.`;
}

function buildInitialUserPrompt(
  intent: ParsedIntent,
  rawQuery?: string,
  clarifications?: Array<{ id: string; question: string; answer: unknown }>,
): string {
  const parts: string[] = [];
  if (rawQuery) {
    parts.push(
      `USER'S ORIGINAL QUERY (verbatim — honor any constraints it mentions, especially exclusions like "outside X", "not Y", "excluding Z"):`,
      `  ${rawQuery}`,
      ``,
    );
  }
  if (clarifications && clarifications.length > 0) {
    parts.push(
      `USER'S CLARIFICATIONS (answered explicitly — treat as hard constraints, they override any parser ambiguity):`,
    );
    for (const c of clarifications) {
      const answer = Array.isArray(c.answer)
        ? (c.answer as unknown[]).map(String).join(', ')
        : String(c.answer ?? '');
      if (answer.trim()) {
        parts.push(`  - ${c.question}`);
        parts.push(`    → ${answer}`);
      }
    }
    parts.push(``);
  }
  parts.push(
    `Parsed intent (derived fields — use these as structured hints, but if they conflict with the original query or clarifications, those win):`,
  );
  parts.push(
    `Query type: ${intent.queryType}`,
    `Target count: ${intent.targetCount}`,
    `Industry: ${intent.industry}`,
    `Geography: ${JSON.stringify(intent.geography)}`,
    `Desired fields: ${intent.desiredFields.join(', ') || '(none specified → any business contact data)'}`,
    `Keywords: ${intent.keywords?.join(', ') || '(none)'}`,
  );
  if (intent.namedEntities?.length) {
    parts.push(`Named entities: ${intent.namedEntities.join(', ')}`);
  }

  // Query-specific output columns (e.g. amount_raised, funding_round) — the
  // agent is expected to fill these in via write_lead's `facts` parameter.
  const schema = intent.outputSchema ?? [];
  if (schema.length > 0) {
    parts.push(``, `OUTPUT SCHEMA — extra columns the user wants beyond standard contact fields. Fill these in on write_lead via the \`facts\` parameter, keyed by \`key\`. Each fact should include {value, unit? (e.g. "USD"), sourceUrl, confidence (0-1), raw? (original snippet)}. Only include a fact when you can justify it from tool output. Required columns must be filled if possible; non-required are nice-to-haves.`);
    for (const col of schema) {
      const req = col.required ? 'REQUIRED' : 'optional';
      const desc = col.description ? ` — ${col.description}` : '';
      parts.push(`  - ${col.key} (${col.type}, ${req}): "${col.label}"${desc}`);
    }
  }

  parts.push(
    ``,
    `Before your first tool call, briefly re-read the original query in your "thought" field and note any exclusions, quality filters, personas, or output columns that aren't obvious from the parsed fields. Then act.`,
  );
  return parts.join('\n');
}

async function callLLM(history: HistoryMsg[]): Promise<string> {
  return callLlm({
    messages: history,
    max_tokens: 1200,
    temperature: 0,
    response_format: { type: 'json_object' },
    timeoutMs: LLM_TIMEOUT_MS,
  });
}

async function runCritic(history: HistoryMsg[], ctx: ToolContext): Promise<string | null> {
  const criticHistory: HistoryMsg[] = [
    {
      role: 'system',
      content: `You are a research-quality critic. Review the agent's progress so far and decide whether to continue, replan, or stop.

Respond with exactly one JSON object:
  { "decision": "continue" | "replan" | "stop", "reasoning": "…", "suggestion"?: "…" }

Decide:
- continue: agent is making progress, no intervention needed
- replan: agent is stuck or wasting budget — include "suggestion" pointing to a better strategy
- stop: agent has enough data OR further work is futile`,
    },
    {
      role: 'user',
      content: `Target: ${ctx.parsedIntent.targetCount} leads. Written so far: ${ctx.leadsSoFar.length}. Recent agent activity:\n${history.slice(-10).map(m => `[${m.role}] ${m.content.slice(0, 400)}`).join('\n\n')}`,
    },
  ];
  try {
    // The critic is a genuine judgment call — use JUDGMENT_LLM_MODEL when set
    // (typically v4-pro). Tool dispatch and per-step calls keep the fast model.
    const raw = await callLlm({
      messages: criticHistory,
      max_tokens: 1200,
      temperature: 0,
      response_format: { type: 'json_object' },
      timeoutMs: LLM_TIMEOUT_MS,
      ...(env.JUDGMENT_LLM_MODEL ? { model: env.JUDGMENT_LLM_MODEL } : {}),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(raw) as any;
    logger.info('[jobAgent][critic]', { decision: parsed?.decision, reasoning: parsed?.reasoning });
    if (parsed?.decision === 'stop') return 'STOP';
    if (parsed?.decision === 'replan' && parsed?.suggestion) {
      return `REPLAN: ${parsed.suggestion}`;
    }
  } catch (err) {
    logger.warn('[jobAgent][critic] failed', { err: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

export async function runJobAgent(input: JobAgentInput): Promise<JobAgentResult> {
  // DISCOVERY_MODE is the primary routing control.
  // Legacy boolean flags (AGENT_SMART_DISCOVERY, AGENT_FAN_OUT_ENABLED) are
  // still honoured within the 'old' branch for backward compatibility.
  if (env.DISCOVERY_MODE === 'hybrid') {
    const hybridResult = await runHybridDiscovery(input);
    if (hybridResult.fallbackToOld) {
      logger.warn('[jobAgent] hybrid returned no candidates — falling back to dispatcher', { jobId: input.jobId });
      return runFanOutJobAgent(input);
    }
    return hybridResult;
  }

  if (env.DISCOVERY_MODE === 'smart' && input.rawQuery) {
    return runSmartJobAgent(input);
  }

  // 'old' path — dispatcher agent loop + fan-out subagents
  const targetCount = input.parsedIntent.targetCount ?? 10;
  if (env.AGENT_FAN_OUT_ENABLED && targetCount >= env.FAN_OUT_MIN_TARGET) {
    return runFanOutJobAgent(input);
  }
  return runSerialJobAgent(input);
}

async function runSmartJobAgent(input: JobAgentInput): Promise<JobAgentResult> {
  const { jobId, workspaceId, parsedIntent, publisher, rawQuery, clarifications } = input;
  logger.info('[jobAgent/smart] starting', { jobId, targetCount: parsedIntent.targetCount });

  await jobActivity(jobId, publisher, 'tool_call', 'Searching the web and extracting leads…', {});

  try {
    const leads = await runSmartDiscovery({
      jobId,
      workspaceId,
      parsedIntent,
      rawQuery: rawQuery ?? '',
      clarifications,
    });

    logger.info('[jobAgent/smart] discovery complete', { jobId, leads: leads.length });

    if (leads.length === 0) {
      logger.warn('[jobAgent/smart] no leads found, falling back to serial agent', { jobId });
      return runSerialJobAgent(input);
    }

    const ranked = rankLeads(leads, parsedIntent.desiredFields);
    await writeLeads(ranked, jobId, workspaceId, publisher);

    return {
      leads: ranked,
      stepsUsed: 3, // search + LLM extraction + email verification
      stopReason: 'agent_done',
      transcript: [`Smart discovery: ${leads.length} leads found`],
      fanOutComplete: true,
      leadsFound: ranked.length,
    };
  } catch (err) {
    logger.error('[jobAgent/smart] failed, falling back to serial', {
      jobId, err: err instanceof Error ? err.message : String(err),
    });
    return runSerialJobAgent(input);
  }
}

async function runFanOutJobAgent(input: JobAgentInput): Promise<JobAgentResult> {
  const { jobId, workspaceId, parsedIntent, publisher } = input;
  const targetCount = parsedIntent.targetCount ?? 10;

  if (!isLlmConfigured()) {
    logger.error('[jobAgent/fanout] LLM not configured', { jobId });
    return { leads: [], stepsUsed: 0, stopReason: 'error', transcript: ['LLM not configured'] };
  }

  // Phase 1: discovery — dispatcher agent builds a candidate list
  const { candidates, stepsUsed: discoverySteps } = await runDispatcherAgent(input);
  logger.info('[jobAgent/fanout] dispatcher finished', { jobId, candidates: candidates.length });

  if (candidates.length === 0) {
    logger.info('[jobAgent/fanout] no candidates found, falling back to serial', { jobId });
    return runSerialJobAgent(input);
  }

  // Phase 2: fan-out — one BullMQ subagent job per candidate
  await updateDispatchedCount(jobId, candidates.length);

  const subagentBudget = { maxSteps: 20, wallClockMs: 90_000 };
  await getSubagentQueue().addBulk(
    candidates.map(c => ({
      name: c.companyName,
      data: {
        parentJobId: jobId,
        workspaceId,
        candidate: c,
        parsedIntent,
        rawQuery: input.rawQuery,
        clarifications: input.clarifications,
        budget: subagentBudget,
      } as ProspectingSubagentJobData,
    })),
  );

  await jobActivity(
    jobId,
    publisher,
    'tool_call',
    `Dispatched ${candidates.length} enrichment subagents`,
    { candidates: candidates.length, targetCount },
  );

  // Phase 3: poll Mongo every 3s until target reached or wall-clock fires
  const gatherDeadline = Date.now() + FAN_OUT_GATHER_TIMEOUT_MS;
  let timedOut = false;

  while (Date.now() < gatherDeadline) {
    const count = await countLeadsForJob(jobId);
    logger.info('[jobAgent/fanout] polling', { jobId, count, targetCount });
    if (count >= targetCount) break;
    await sleep(3_000);
  }
  if (Date.now() >= gatherDeadline) {
    timedOut = true;
    logger.info('[jobAgent/fanout] wall-clock exhausted', { jobId });
  }

  // Phase 4: collect + rank + persist via writeLeads (handles lifecycle once)
  const finalLeads = await queryLeadsForJob(jobId);
  const ranked = rankLeads(finalLeads, parsedIntent.desiredFields);
  await writeLeads(ranked, jobId, workspaceId, publisher);

  logger.info('[jobAgent/fanout] complete', { jobId, leads: finalLeads.length });
  return {
    leads: [],
    stepsUsed: discoverySteps,
    stopReason: timedOut ? 'wall_clock' : 'target_reached',
    transcript: [],
    fanOutComplete: true,
    leadsFound: finalLeads.length,
  };
}

async function runSerialJobAgent(input: JobAgentInput): Promise<JobAgentResult> {
  const { jobId, workspaceId, parsedIntent, rawQuery, clarifications, publisher } = input;

  if (!isLlmConfigured()) {
    logger.error('[jobAgent] LLM not configured — set USE_LOCAL_LLM or OPENROUTER_API_KEY');
    return { leads: [], stepsUsed: 0, stopReason: 'error', transcript: ['LLM not configured'] };
  }

  const ctx: ToolContext = {
    jobId, workspaceId, publisher, parsedIntent,
    leadsSoFar: [],
    pagesScrapedThisJob: new Set<string>(),
  };

  const transcript: string[] = [];
  const startedAt = Date.now();
  const targetCount = parsedIntent.targetCount ?? 10;

  // Compute per-job wall-clock budget and step cap from parsed intent.
  const { budgetMs, explanation } = estimateWallClockMs(parsedIntent);
  const maxSteps = Math.min(
    ABSOLUTE_MAX_STEPS,
    Math.max(BASE_MAX_STEPS, BASE_MAX_STEPS + targetCount * STEPS_PER_LEAD),
  );
  logger.info('[jobAgent] budget', { jobId, budgetMs, maxSteps, explanation });

  const history: HistoryMsg[] = [
    { role: 'system', content: buildSystemPrompt(maxSteps, budgetMs) },
    { role: 'user', content: buildInitialUserPrompt(parsedIntent, rawQuery, clarifications) },
  ];

  for (let step = 0; step < maxSteps; step++) {
    if (ctx.leadsSoFar.length >= targetCount) {
      logger.info('[jobAgent] target reached', { step, leads: ctx.leadsSoFar.length });
      return { leads: ctx.leadsSoFar, stepsUsed: step, stopReason: 'target_reached', transcript };
    }
    if (Date.now() - startedAt > budgetMs) {
      logger.info('[jobAgent] wall-clock budget exhausted', { step, budgetMs, leads: ctx.leadsSoFar.length });
      return { leads: ctx.leadsSoFar, stepsUsed: step, stopReason: 'wall_clock', transcript };
    }

    let raw: string;
    try {
      raw = await callLLM(history);
    } catch (err) {
      logger.warn('[jobAgent] LLM call failed', { step, err: err instanceof Error ? err.message : String(err) });
      return { leads: ctx.leadsSoFar, stepsUsed: step, stopReason: 'error', transcript };
    }
    transcript.push(`[${step}] ← ${raw.slice(0, 400)}`);
    history.push({ role: 'assistant', content: raw });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      history.push({ role: 'user', content: 'Your previous response was not valid JSON. Return exactly one JSON object per the system prompt.' });
      continue;
    }

    if (parsed?.done === true) {
      logger.info('[jobAgent] agent signaled done', { step, leads: ctx.leadsSoFar.length, summary: parsed.summary });
      return { leads: ctx.leadsSoFar, stepsUsed: step, stopReason: 'agent_done', transcript };
    }

    const toolName = parsed?.tool;
    if (!toolName || !TOOL_REGISTRY.find(t => t.name === toolName)) {
      history.push({
        role: 'user',
        content: `Your response must include "tool": "<one of ${TOOL_REGISTRY.map(t => t.name).join(', ')}>" or "done": true. Try again.`,
      });
      continue;
    }

    logger.info('[jobAgent] tool call', { step, tool: toolName, thought: parsed.thought?.slice(0, 200) });
    // Use the canonical jobActivity helper so this event (a) lands in
    // Mongo `activityLog` for bootstrap-on-reconnect, and (b) emits the
    // `{type,at,step,message,meta}` shape the frontend useJob() hook
    // actually listens for. Previously we published a bespoke
    // `{type,stage,ts,title,meta}` shape which the frontend silently
    // dropped — the live audit trail stayed empty for most of the run.
    await jobActivity(
      jobId,
      publisher,
      'tool_call',
      `Step ${step + 1}: ${toolName}`,
      {
        tool: toolName,
        step,
        thought: parsed.thought?.slice(0, 200),
      },
    );

    const toolResult = await executeTool(toolName, parsed.args ?? {}, ctx);
    transcript.push(`[${step}] → ${toolName} → ${toolResult.output.slice(0, 300)}`);
    history.push({ role: 'user', content: `Tool ${toolName} result (ok=${toolResult.ok}):\n${toolResult.output}` });

    // Critic checkpoint
    if ((step + 1) % CRITIC_INTERVAL === 0 && ctx.leadsSoFar.length < targetCount) {
      const criticVerdict = await runCritic(history, ctx);
      if (criticVerdict === 'STOP') {
        logger.info('[jobAgent] critic stopped run', { step, leads: ctx.leadsSoFar.length });
        await jobActivity(jobId, publisher, 'critic_stop', 'Critic stopped the run', {
          leadsFound: ctx.leadsSoFar.length,
        });
        return { leads: ctx.leadsSoFar, stepsUsed: step, stopReason: 'agent_done', transcript };
      }
      if (criticVerdict?.startsWith('REPLAN:')) {
        const feedback = criticVerdict.slice(7).trim();
        history.push({ role: 'user', content: `CRITIC FEEDBACK: ${feedback}` });
        await jobActivity(jobId, publisher, 'critic_replan', 'Critic requested replan', {
          feedback: feedback.slice(0, 600),
        });
      }
    }
  }

  logger.info('[jobAgent] max steps reached', { leads: ctx.leadsSoFar.length, maxSteps });
  return { leads: ctx.leadsSoFar, stepsUsed: maxSteps, stopReason: 'max_steps', transcript };
}
