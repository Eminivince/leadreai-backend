import { logger } from '../utils/logger.js';
import { DISPATCHER_TOOLS, executeTool, renderToolMenu, type ToolContext, type Candidate } from './tools/index.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';
import { jobActivity } from './intentParser.js';
import type { JobAgentInput } from './jobAgent.js';

const DISPATCHER_MAX_STEPS = 40;
const DISPATCHER_BUDGET_MS = 60_000; // 60 s for the discovery phase
const LLM_TIMEOUT_MS = 45_000;

type HistoryMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export interface DispatcherResult {
  candidates: Candidate[];
  stepsUsed: number;
}

function buildDispatcherSystemPrompt(targetCandidates: number): string {
  return `You are the DISCOVERY AGENT for a B2B prospecting system.

Your sole job: build a list of **${targetCandidates} candidate companies** matching the query. You MUST call \`queue_company\` for each valid candidate you find.

## Available tools

${renderToolMenu(DISPATCHER_TOOLS)}

## Response format (strict JSON, no markdown)

  {"thought": "…", "tool": "<name>", "args": {…}}   — call a tool
  {"done": true, "summary": "…"}                      — when you have ≥${targetCandidates} candidates OR no more ideas

## Discovery strategy

1. Call \`search_workspace_leads\` FIRST (free reuse of prior research).
2. Call \`list_companies\` + \`lookup_registry\` for the industry/geo.
3. Use \`search_web\` + \`fetch_url\` for additional names / domains.
4. For each discovered company: call \`queue_company({companyName, companyDomain, hints})\`.
   - hints: 2–3 short snippets (job titles, descriptions) that a subagent can act on.
5. Stop when candidates ≥ ${targetCandidates}. Emit done:true.

## Hard rules

- Do NOT enrich. Do NOT call fetch_file, scrape_page, verify_email, write_lead.
- Do NOT fabricate domains.
- Budget: ${DISPATCHER_MAX_STEPS} steps, ${Math.round(DISPATCHER_BUDGET_MS / 1000)} s wall-clock.`;
}

function buildDispatcherUserPrompt(input: JobAgentInput): string {
  const { parsedIntent, rawQuery, clarifications } = input;
  const parts: string[] = [];
  if (rawQuery) parts.push(`Query: "${rawQuery}"`);
  parts.push(
    `Industry: ${parsedIntent.industry ?? 'any'}`,
    `Geography: ${JSON.stringify(parsedIntent.geography ?? {})}`,
    `Target count: ${parsedIntent.targetCount ?? 10}`,
    `Query type: ${parsedIntent.queryType}`,
  );
  if (clarifications?.length) {
    parts.push(`Clarifications:`);
    for (const c of clarifications) {
      parts.push(`  Q: ${c.question}  A: ${String(c.answer ?? '')}`);
    }
  }
  return parts.join('\n');
}

async function callLLM(history: HistoryMsg[]): Promise<string> {
  return callLlm({
    messages: history,
    max_tokens: 800,
    temperature: 0,
    response_format: { type: 'json_object' },
    timeoutMs: LLM_TIMEOUT_MS,
  });
}

export async function runDispatcherAgent(input: JobAgentInput): Promise<DispatcherResult> {
  const { jobId, workspaceId, parsedIntent, publisher } = input;

  if (!isLlmConfigured()) {
    logger.error('[dispatcher] LLM not configured', { jobId });
    return { candidates: [], stepsUsed: 0 };
  }

  const targetCandidates = Math.ceil((parsedIntent.targetCount ?? 10) * 1.5);

  const ctx: ToolContext = {
    jobId,
    workspaceId,
    publisher,
    parsedIntent,
    leadsSoFar: [],
    pagesScrapedThisJob: new Set<string>(),
    candidatesSoFar: [],
  };

  const history: HistoryMsg[] = [
    { role: 'system', content: buildDispatcherSystemPrompt(targetCandidates) },
    { role: 'user', content: buildDispatcherUserPrompt(input) },
  ];

  const startedAt = Date.now();
  let stepsUsed = 0;

  for (let step = 0; step < DISPATCHER_MAX_STEPS; step++) {
    stepsUsed = step + 1;
    if ((ctx.candidatesSoFar?.length ?? 0) >= targetCandidates) {
      logger.info('[dispatcher] candidate target reached', { jobId, step, count: ctx.candidatesSoFar?.length });
      break;
    }
    if (Date.now() - startedAt > DISPATCHER_BUDGET_MS) {
      logger.info('[dispatcher] wall-clock budget exhausted', { jobId, step });
      break;
    }

    let raw: string;
    try {
      raw = await callLLM(history);
    } catch (err) {
      logger.warn('[dispatcher] LLM call failed', { step, err: err instanceof Error ? err.message : String(err) });
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

    // fire-and-forget: discovery phase optimises for throughput over per-step audit completeness
    jobActivity(jobId, publisher, 'tool_call', `[dispatch] ${toolName}`, { tool: toolName, step }).catch(() => {});
    const result = await executeTool(toolName, parsed.args ?? {}, ctx, DISPATCHER_TOOLS);
    history.push({ role: 'user', content: `Tool ${toolName} result (ok=${result.ok}):\n${result.output}` });
  }

  const candidates = ctx.candidatesSoFar ?? [];
  logger.info('[dispatcher] finished', { jobId, candidates: candidates.length, stepsUsed });
  return { candidates, stepsUsed };
}
