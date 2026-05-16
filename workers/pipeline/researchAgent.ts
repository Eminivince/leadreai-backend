import { logger } from '../utils/logger.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';
import type { ContactCandidate } from './aiContactExtractor.js';
import { fetchUrl } from './tools/fetchUrl.js';
import { searchWeb } from './tools/searchWeb.js';
import { permuteEmail } from './tools/permuteEmail.js';
import { verifyEmail } from './tools/verifyEmail.js';

export interface AgentInput {
  domain: string;
  entityName?: string;
  desiredFields: string[];
  knownContacts: ContactCandidate[];
  pagesAlreadyScraped: string[];
}

export interface AgentResult {
  additionalContacts: ContactCandidate[];
  toolCallsUsed: number;
  stopReason: 'done' | 'max_steps' | 'timeout' | 'error';
  transcript: string;
}

const MAX_STEPS = 6;
const MAX_WALL_MS = 60_000;
const AI_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You are an autonomous lead-research agent. You are given a company domain and a list of what the user wants (emails, phones, named contacts). You have a small toolkit and a strict step budget.

Tools you can call (respond with EXACTLY ONE of these JSON forms each turn, no markdown, no prose):

{ "tool": "fetch_url", "args": { "url": "https://..." }, "thought": "..." }
  → Fetch a specific page (contact page, staff page, about page). Returns cleaned text + emails/phones/JSON-LD.

{ "tool": "search_web", "args": { "query": "...", "site": "linkedin.com" (optional) }, "thought": "..." }
  → Web search. Use 'site' to restrict to a specific domain. Returns 5 title/snippet/url triples.

{ "tool": "permute_email", "args": { "firstName": "...", "lastName": "..." }, "thought": "..." }
  → Generate 12 common email patterns for a named person. Returns a list; you must verify_email each before emitting as a contact.

{ "tool": "verify_email", "args": { "address": "..." }, "thought": "..." }
  → MX lookup. Returns { hasMx, verdict }. 'invalid_domain' means reject. 'likely_valid' means domain accepts mail (not a deliverability guarantee).

{ "done": true, "contacts": [ContactCandidate, ...], "summary": "..." }
  → Emit final contacts and stop. Use when you have everything, or when further tool calls would be wasteful.

ContactCandidate shape: { name?, title?, department?, email?, phone?, confidence (0-1), sourceType }

STRATEGY:
1. If knownContacts already has a named contact with verified email → emit done immediately.
2. Start by fetching '/contact', '/about', '/team', or '/leadership' on the target domain if not already scraped.
3. If you find a name but no email → search_web for "<name>" "<company>" to find LinkedIn/bio pages.
4. If you have a name and domain but no email → permute_email then verify_email on top candidates.
5. Only emit contacts you can justify: at minimum, email must have hasMx=true. Confidence 0.9+ for verified named contacts; 0.6 for unverified patterns.
6. BUDGET IS 6 STEPS. Spend them wisely. Prefer targeted single pages over broad searches.
7. Never fabricate names or addresses. If you can't find real data, return { "done": true, "contacts": [] }.

RETURN ONLY JSON. NO MARKDOWN FENCES.`;

type HistoryMsg = { role: 'system' | 'user' | 'assistant'; content: string };

function buildInitialContext(input: AgentInput): string {
  const knownSummary = input.knownContacts.length > 0
    ? input.knownContacts.map(c => `- ${c.name ?? '(no name)'} | ${c.title ?? '(no title)'} | ${c.email ?? '—'} | ${c.phone ?? '—'} | conf ${c.confidence}`).join('\n')
    : '(none)';
  return `Target domain: ${input.domain}
Entity name: ${input.entityName ?? 'unknown — infer from the domain'}
Desired fields: ${input.desiredFields.join(', ') || 'any business contact data'}

Already-scraped pages:
${input.pagesAlreadyScraped.slice(0, 10).join('\n') || '(none)'}

Known contacts so far:
${knownSummary}

What is your first action?`;
}

async function callLLM(history: HistoryMsg[]): Promise<string> {
  return callLlm({
    messages: history,
    max_tokens: 800,
    temperature: 0,
    response_format: { type: 'json_object' },
    timeoutMs: AI_TIMEOUT_MS,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeTool(tool: string, args: any, domain: string): Promise<string> {
  switch (tool) {
    case 'fetch_url': {
      const result = await fetchUrl(String(args?.url ?? ''));
      return JSON.stringify({
        status: result.status,
        emails: result.emails,
        phones: result.phones,
        jsonLdCount: result.jsonLd.length,
        bodyTextPreview: result.bodyText.slice(0, 2000),
      });
    }
    case 'search_web': {
      const results = await searchWeb(String(args?.query ?? ''), args?.site, 5);
      return JSON.stringify(results);
    }
    case 'permute_email': {
      const patterns = permuteEmail(domain, args?.firstName, args?.lastName);
      return JSON.stringify(patterns);
    }
    case 'verify_email': {
      const result = await verifyEmail(String(args?.address ?? ''));
      return JSON.stringify(result);
    }
    default:
      return JSON.stringify({ error: `unknown tool: ${tool}` });
  }
}

export async function researchDomain(input: AgentInput): Promise<AgentResult> {
  if (!isLlmConfigured()) {
    return { additionalContacts: [], toolCallsUsed: 0, stopReason: 'error', transcript: 'LLM not configured' };
  }

  const startedAt = Date.now();
  const transcriptLines: string[] = [];
  const history: HistoryMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildInitialContext(input) },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    if (Date.now() - startedAt > MAX_WALL_MS) {
      return {
        additionalContacts: [], toolCallsUsed: step, stopReason: 'timeout',
        transcript: transcriptLines.join('\n'),
      };
    }

    let raw: string;
    try {
      raw = await callLLM(history);
    } catch (err) {
      logger.warn('[researchAgent] LLM call failed', { domain: input.domain, step, err: err instanceof Error ? err.message : String(err) });
      return {
        additionalContacts: [], toolCallsUsed: step, stopReason: 'error',
        transcript: transcriptLines.join('\n'),
      };
    }

    transcriptLines.push(`[${step}] ← ${raw.slice(0, 300)}`);
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
      const contacts = Array.isArray(parsed.contacts) ? parsed.contacts : [];
      const cleaned: ContactCandidate[] = contacts
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => c && (c.email || c.phone || c.name))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => ({
          ...c,
          confidence: Math.max(0, Math.min(1, Number(c.confidence ?? 0.6))),
          sourceType: c.sourceType ?? 'body_text',
        }));
      logger.info('[researchAgent] done', {
        domain: input.domain, step, emitted: cleaned.length, summary: parsed.summary,
      });
      return {
        additionalContacts: cleaned, toolCallsUsed: step,
        stopReason: 'done', transcript: transcriptLines.join('\n'),
      };
    }

    if (!parsed?.tool) {
      history.push({ role: 'user', content: 'Your response must include either a "tool" field or a "done": true field.' });
      continue;
    }

    const toolResult = await executeTool(parsed.tool, parsed.args ?? {}, input.domain);
    transcriptLines.push(`[${step}] → ${parsed.tool} → ${toolResult.slice(0, 200)}`);
    history.push({ role: 'user', content: `Tool ${parsed.tool} result:\n${toolResult}` });
  }

  logger.info('[researchAgent] max steps reached', { domain: input.domain });
  return {
    additionalContacts: [], toolCallsUsed: MAX_STEPS, stopReason: 'max_steps',
    transcript: transcriptLines.join('\n'),
  };
}
