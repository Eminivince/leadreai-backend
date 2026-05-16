import { ParsedIntentSchema, type ParsedIntent, type ClarificationAnswer } from '../../../shared/index.js';
import { generateText, type AiMessage } from './aiProvider.js';
import { ApiError } from '../../utils/ApiError.js';
import { env } from '../../config/env.js';

export const PARSER_SYSTEM_PROMPT = `You are a lead-generation query parser. Your sole job is to extract structured intent from a natural-language prospecting query and return it as a single, valid JSON object.

CRITICAL OUTPUT RULES (violating any of these is a failure):
- Output ONLY the JSON object. First character MUST be "{". Last character MUST be "}".
- NO markdown, NO code fences, NO preamble, NO reasoning, NO explanation, NO trailing commentary.
- Do NOT "think out loud". Do NOT describe your reasoning. Emit the JSON and stop.

Output EXACTLY this JSON schema (all keys required; use null only where explicitly allowed):

{
  "industry": "<string | null> — primary industry if the query states or strongly implies one (e.g. 'fintech', 'law firms', 'accounting'). Use null ONLY when the query names a specific company by name without industry context (e.g. 'contact info for Acme Corp') — in that case enrichment will infer it later. DO NOT invent an industry from a company name alone.",
  "subIndustry": "<string | null> — more specific vertical if mentioned, otherwise null",
  "geography": {
    "country": "<string | null>",
    "state": "<string | null>",
    "city": "<string | null>"
  },
  "targetCount": "<integer 1-10> — leads requested; DEFAULT 10 if the user did not specify a number; for 'top N' use N (capped at 10). Never propose more than 10 even if the user asks for more — downstream code clamps anyway.",
  "desiredFields": "<array of strings> — pick any subset of: 'businessEmail', 'officePhone', 'mobilePhone', 'address', 'website', 'linkedin', 'whois', 'techStack'; default to ['businessEmail'] if none implied. Infer: 'email' → 'businessEmail'; 'phone' → 'officePhone'; 'website' → 'website'; 'LinkedIn' → 'linkedin'; etc. NEVER invent new field names.",
  "companySize": "<string | null> — e.g. '50-200', 'startup', 'enterprise', or null",
  "keywords": "<string[]> — relevant search terms extracted from the query",
  "confidenceScore": "<number 0-1> — decimal confidence",
  "queryType": "<'named_entity_list' | 'demographic_filter' | 'contact_lookup'>",
  "namedEntities": "<string[] | null> — specific company/org names ONLY if query mentions them (e.g. ['Aluko & Oyebode']); null otherwise",
  "outputSchema": "<array> — extra columns the user wants beyond standard contact fields. One entry per column. Empty [] if the query only asks for standard fields (name/email/phone/website).",
  "userOffering": "<string | null> — what the person submitting the query is selling or offering, if stated or strongly implied. Extract the SERVICE being sold to the leads, not the leads themselves. Examples: query 'travel agencies that need flight booking software' → 'flight booking software'; 'find law firms for our legal research service' → 'legal research service'; 'I need Nigerian fintechs' (no offering stated) → null. Keep it concise (under 15 words).",
  "targetBuyerIndustries": "<string[] | null> — REQUIRED reasoning step when userOffering is set: which industries/sectors of company would BUY this offering? Returns 3-7 broad industry labels. Examples: userOffering='travel agency services for staff bookings' → ['oil & gas','consulting','NGOs','construction','manufacturing','education','multinationals']; userOffering='industrial paint' → ['construction','real estate','automotive workshops','manufacturing','marine services']; userOffering='B2B accounting software' → ['startups','SMEs','professional services','retail','manufacturing']. Set to null when (a) userOffering is null, OR (b) the query already names the target industry directly so industry is enough. CRITICAL: this list must NOT include the user's offering itself — if user sells travel-agency services, the buyers are NOT travel agencies, they are corporates that NEED travel agencies.",
  "excludeWellKnown": "<boolean> — true ONLY when the brief explicitly excludes prominent / well-known / household-name companies. Cues that warrant true: 'small companies', 'not big', 'not the big ones', 'not household names', 'not popular', 'lesser-known', 'upcoming', 'under-the-radar', 'mid-market', 'don't want major brands', 'not already established'. When in doubt, default to false — only set true when the brief is unambiguous about avoiding prominent companies."
}

outputSchema entries: each object has {key, label, type, description, required}.
- key: lowercase_snake_case slug (e.g. 'amount_raised', 'funding_round', 'raised_on', 'hire_count')
- label: human header (e.g. 'Amount Raised', 'Funding Round')
- type: one of 'text','number','currency','percentage','date','url','email','phone','tags'. PICK FROM THIS LIST ONLY.
- description: one-line meaning (optional, <200 chars)
- required: true if the user explicitly names this column; false if you're inferring it would be useful
Examples:
  "top 20 fintechs with funding info"
    → [{"key":"amount_raised","label":"Amount Raised","type":"currency","required":true},
       {"key":"funding_round","label":"Funding Round","type":"text","required":true},
       {"key":"raised_on","label":"Date Raised","type":"date","required":false}]
  "companies hiring engineers in Lagos"
    → [{"key":"open_roles","label":"Open Roles","type":"tags","required":true},
       {"key":"hire_count","label":"Hires Announced","type":"number","required":false}]
  "list 50 Nigerian fintechs, show company email and phone"
    → [] (email + phone are standard contact fields — use desiredFields, NOT outputSchema)
  Rule: if a requested column is already covered by standard contact fields (businessEmail, officePhone, mobilePhone, address, website, linkedin, whois, techStack), do NOT duplicate it in outputSchema — add it to desiredFields instead.

queryType classification:
- 'named_entity_list': user wants top-N or specific named orgs (e.g. 'top 10 law firms in Nigeria', 'biggest banks in Ghana')
- 'contact_lookup': user wants contact info for specific named companies (e.g. 'phone number of Aluko and Oyebode', 'anyone at FUR ALLE LIMITED')
- 'demographic_filter': filter-based prospecting (e.g. 'Series B fintechs in NYC using Salesforce')

Rules:
- targetCount must be an integer 1-10. If unspecified, use 10. If the user requests more (e.g. "find 50"), clamp to 10 — discovery and enrichment cost scales linearly so we cap per-job to control latency and spend.
- confidenceScore must be a decimal 0-1.
- desiredFields must be a non-empty array from the allowed enum ONLY.
- For named_entity_list with 'top N': set targetCount=min(N,10). If no specific names, namedEntities is null.
- For contact_lookup with explicit company names: list them in namedEntities.
- For demographic_filter: namedEntities is ALWAYS null.
- outputSchema is ALWAYS an array (possibly empty []), never null. Keys must be unique.
- CRITICAL — distinguish "what the user sells" from "what the user wants to find". Briefs like "find corporates that need travel agencies" mean the user SELLS travel-agency services and wants CORPORATE BUYERS of those services. The target is the BUYER, not the offering. When you see this shape:
    * Set userOffering = the service the user is selling ("travel agency services for staff bookings").
    * Set targetBuyerIndustries = the industries that would BUY this ("oil & gas", "consulting", etc.). Multiple entries — usually 4-7.
    * Set industry = null UNLESS the brief also names a specific buyer industry the user wants to focus on.
    * keywords should reflect the BUYER side (e.g. "corporate staff travel", "regional offices", "field operations") — NOT the user's offering keywords (NOT "travel agencies", "flight tickets", "hotels").
  If you set the target keywords to describe the user's offering, downstream code searches for the user's competitors instead of clients. This is the single most common parser failure mode — be explicit about which side of the transaction each field describes.

REMINDER: Your entire response must be a single valid JSON object. No prose before, no prose after. Start with "{". End with "}".`;

/**
 * Scans text for the first balanced {...} block. Returns the extracted substring or null.
 * Tolerant of prose before/after the JSON; tolerant of strings containing braces.
 */
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
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Formats clarification Q&A pairs into a plain-text block appended to the
 * user message, so the parser treats them as additional context without
 * us needing to structurally map each answer to a specific ParsedIntent
 * field. Answers also flow down to the agent so it can honor constraints
 * the parser didn't capture.
 */
function formatClarifications(clarifications: ClarificationAnswer[] | undefined): string {
  if (!clarifications || clarifications.length === 0) return '';
  const lines = clarifications.map((c) => {
    const answer = Array.isArray(c.answer) ? c.answer.join(', ') : c.answer;
    return `- ${c.question}\n  Answer: ${answer}`;
  });
  return `\n\nCLARIFICATIONS (answered by user — honor these as hard constraints):\n${lines.join('\n')}`;
}

/**
 * Parses a raw natural-language prospecting query into a structured ParsedIntent
 * using the configured AI provider. On schema failure, retries ONCE with a
 * correction prompt that includes the previous bad output and Zod's complaints.
 *
 * `clarifications` are the user's answers to the clarifier checklist. They're
 * formatted as a plain-text appendix to the user message — the parser treats
 * them as additional query context.
 */
export async function parseQuery(
  rawQuery: string,
  clarifications?: ClarificationAnswer[],
): Promise<ParsedIntent> {
  if (!rawQuery.trim()) {
    throw ApiError.badRequest('rawQuery must not be empty');
  }

  const userContent = `${rawQuery}${formatClarifications(clarifications)}`;
  const conversation: AiMessage[] = [{ role: 'user', content: userContent }];
  const MAX_ATTEMPTS = 2;
  let lastRawResponse = '';
  let lastZodIssues: unknown = null;
  let lastParsed: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await generateText(conversation, {
      systemPrompt: PARSER_SYSTEM_PROMPT,
      cacheSystem: true,
      maxTokens: 2048,
      // Intent parsing is a judgment task — distinguishing "what user
      // sells" from "what user wants to find", inferring buyer industries
      // from a stated offering. v4-pro's chain-of-thought handles this
      // nuance better than V3's mechanical extraction. One call per job
      // — the latency cost is paid back many times over downstream when
      // the wrong intent doesn't waste the rest of the pipeline.
      ...(env.USE_OPENROUTER && env.JUDGMENT_LLM_MODEL
        ? { model: env.JUDGMENT_LLM_MODEL }
        : {}),
    });
    lastRawResponse = response.text;

    const extracted = extractFirstJsonObject(response.text);
    if (!extracted) {
      console.error(
        '[queryParser] no JSON object found (attempt %d/%d)\nprovider=%s\nrawResponse=\n%s',
        attempt, MAX_ATTEMPTS, response.provider, response.text,
      );
      if (attempt === MAX_ATTEMPTS) {
        throw new ApiError(502, 'AI_PARSE_ERROR', 'AI returned unparseable response');
      }
      conversation.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'Your previous response contained no valid JSON object. Respond with ONLY the JSON object, starting with "{" and ending with "}". No prose. No reasoning. No preamble.' },
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted);
    } catch {
      console.error(
        '[queryParser] JSON.parse failed (attempt %d/%d)\nextracted=\n%s',
        attempt, MAX_ATTEMPTS, extracted,
      );
      if (attempt === MAX_ATTEMPTS) {
        throw new ApiError(502, 'AI_PARSE_ERROR', 'AI returned unparseable response');
      }
      conversation.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'Your previous response had invalid JSON syntax. Respond with ONLY a syntactically valid JSON object. No prose. No trailing commas.' },
      );
      continue;
    }
    lastParsed = parsed;

    const result = ParsedIntentSchema.safeParse(parsed);
    if (result.success) {
      // Hard server-side clamps independent of model compliance:
      //   - targetCount is capped at 10 per job (cost / latency control;
      //     each lead burns SERP, LLM, and Hunter budget).
      //   - Missing or malformed targetCount defaults to 10.
      // This runs after the schema parse so the LLM can't override either.
      const tc = result.data.targetCount;
      const clamped = !Number.isFinite(tc) || tc == null
        ? 10
        : Math.max(1, Math.min(10, Math.floor(tc)));
      return { ...result.data, targetCount: clamped };
    }
    lastZodIssues = result.error.issues;

    if (attempt === MAX_ATTEMPTS) {
      console.error(
        '[queryParser] AI_SCHEMA_ERROR after %d attempts\nprovider=%s\nrawQuery=%j\nlastRawResponse=\n%s\nlastParsedJSON=%j\nzodIssues=%j',
        MAX_ATTEMPTS, response.provider, rawQuery, lastRawResponse, lastParsed, lastZodIssues,
      );
      throw new ApiError(502, 'AI_SCHEMA_ERROR', 'AI response did not match expected structure');
    }

    // Feed the model its own output + the specific Zod complaints so it can correct.
    const issueSummary = result.error.issues
      .map((i) => `- path=${i.path.join('.') || '(root)'} code=${i.code} message=${i.message}`)
      .join('\n');
    conversation.push(
      { role: 'assistant', content: response.text },
      {
        role: 'user',
        content: `Your previous response failed schema validation:\n${issueSummary}\n\nRespond again with ONLY a valid JSON object that conforms to the schema. Fix the fields above. No prose. No reasoning. No preamble. Start with "{" and end with "}".`,
      },
    );
  }

  // Unreachable — loop always returns or throws — but satisfies TS.
  throw new ApiError(502, 'AI_SCHEMA_ERROR', 'AI response did not match expected structure');
}
