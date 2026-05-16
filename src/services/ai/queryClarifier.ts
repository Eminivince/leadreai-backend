import { z } from 'zod';
import {
  ClarificationQuestionSchema,
  type ClarificationQuestion,
} from '../../../shared/index.js';
import { generateText, type AiMessage } from './aiProvider.js';
import { ApiError } from '../../utils/ApiError.js';
import { env } from '../../config/env.js';

/**
 * The LLM only emits `{questions: [...]}`. The shared
 * `ClarifyResponseSchema` also requires `policy`, but policy comes
 * from `checkQueryPolicy()` — a separate call, not the LLM. Parsing
 * the LLM output with `ClarifyResponseSchema` silently failed every
 * call and dropped clarifications entirely.
 *
 * This schema matches the prompt contract exactly: questions only,
 * nothing else required.
 */
const LlmClarifyOutputSchema = z.object({
  questions: z.array(ClarificationQuestionSchema).max(8),
});

/**
 * Generates a short clarifying-question checklist from a raw NL query.
 *
 * Commercial goal: narrow the agent's search space BEFORE it burns credits.
 * An ambiguous query ("fintechs in Africa") wastes 10+ agent steps exploring
 * directions the user never wanted; 30 seconds of clarification upfront
 * often halves the run cost and doubles reply quality.
 *
 * Prompt discipline: ZERO questions is a valid answer. Only ask what
 * materially changes the research. Skipping trivia is more valuable than
 * filling the screen.
 */

export const CLARIFIER_SYSTEM_PROMPT = `You are a research-briefing assistant. You receive a user's natural-language prospecting query and decide whether clarifying questions are needed before research begins.

DECISION RULE — ask yourself first:
"Does this query already give the research agent enough to return a relevant list without guessing?"
If YES → return { "questions": [] }. Do NOT manufacture questions just to look thorough.
If NO → ask only the questions whose answers would materially change which companies or people are returned.

CRITICAL OUTPUT RULES:
- Output ONLY a JSON object. First character MUST be "{". Last character MUST be "}".
- NO markdown, NO code fences, NO preamble, NO reasoning, NO trailing commentary.

Schema: {"questions": [{id, question, type, options?, required, placeholder?, rationale}]}

Question-count policy:
- ZERO questions is the right answer whenever the query is already specific enough to research. Examples: a named entity lookup, a query that already pins industry + geography + role, a request that names specific companies.
- Ask questions ONLY when an axis is genuinely ambiguous AND the ambiguity would cause the agent to return irrelevant results. "Nice to know" is not enough — the answer must change the search.
- Hard upper bound: 8. Aim for 1–4 on genuinely vague queries. Never pad.
- The bar for each question: "If the user skips this, would the agent likely return wrong results?" If no → drop it.

WHAT MAKES A QUERY AMBIGUOUS — common patterns to watch for, NOT a checklist to fill:
- The persona is unclear (e.g. "leads at fintechs" — leads = which role? founder? sales? procurement?).
- The product/category covers many sub-types (e.g. "fintech" → payments / lending / wealth / insurtech are different worlds).
- The buyer-segment of the target company is unclear (B2B vs. B2C; SMB vs. enterprise — flips the candidate set).
- The geography is broader than the searcher likely intends (e.g. "African" when they probably mean Lagos).
- Size or stage is undefined and changes which sources we'd search.
- "What WOULDN'T work" is unstated (disqualifiers are the highest-leverage signal).
- An exemplar — name a real perfect-fit — would dramatically anchor a vague brief.

Use these as POSSIBILITIES, not slots to fill. If the query already pins persona, don't ask about persona. If geography is named precisely, don't ask about geography. Some queries are already specific in 4 of the 7 dimensions and only need 1-2 questions; others are genuinely vague and need 4-5. NEVER ask about dimensions the query has already answered.

Hard rules on question craft:
- Match the user's vernacular. If they wrote "businesses I can sell aviation services to," your question should sound like "What kind of aviation services?" — not consultant-speak like "What is the target ICP product category?". Read the query, mirror its register.
- Prefer \`type: "single"\` or \`type: "multi"\` when a short enumerable answer set exists. Use \`type: "text"\` for truly open answers (exemplar list, rejection notes, custom constraints).
- Every \`single\` / \`multi\` question: 3-8 sharp, non-overlapping \`options\`. Always include a neutral escape ("Any", "No preference", "Open to all"). Options should reflect the SPECIFIC query's domain, not generic SaaS-speak.
- Mark \`required: true\` only when proceeding without an answer would almost certainly produce mis-targeted leads. Aim for 0-2 required questions per brief, not everything.
- Every question needs a one-sentence \`rationale\` — what the answer changes about the research (which tool, which filter, which set of companies).
- \`id\`: lowercase_snake_case slug derived from the QUESTION's content. Pick something natural like \`aviation_service_type\`, \`wedding_budget_tier\`, \`retail_subsector\`. Do NOT default to a fixed schema — let the slug emerge from the question being asked.

Anti-patterns — NEVER:
- Confirm something already in the query ("you said Nigeria — confirm Nigeria?").
- Re-ask for things the user can specify in a structured query parameter ("how many leads?" — that's a number field, not a clarification).
- Use generic SaaS-speak when the query is about a non-SaaS domain (don't ask about "ARR" for a wedding planner search).
- Pad the question list to look thorough. 0-2 sharp questions beats 5 weak ones.
- Ask about output formatting (CSV vs JSON, which columns) — the parser handles that.

EXAMPLES — note how each query produces a DIFFERENT shape of question set, in the user's own register, with slugs derived from the question content. Do NOT copy these slugs/options into other queries; they're illustrative.

---

Query: "phone number of Aluko and Oyebode"
Reasonable output (named entity lookup — nothing to clarify):
{ "questions": [] }

---

Query: "I need 5 businesses I can sell my aviation services to. I help them book flights and hotels for their staff. Strictly Nigeria. Not household names — small upcoming companies. I need email and phone."
Reasonable output (the brief has geography, size, and disqualifier — only the buyer industry is wide open):
{
  "questions": [
    {
      "id": "buyer_industry",
      "question": "Which kinds of Nigerian companies are likely to need aviation/travel services?",
      "type": "multi",
      "options": ["Oil & gas / energy", "Mining & construction", "Consulting & professional services", "NGOs & development orgs", "Multinational subsidiaries", "Logistics & shipping", "I'm not sure — cast a wide net"],
      "required": true,
      "rationale": "Aviation-heavy Nigerian SMEs cluster in a few sectors. Pinning this filters the candidate pool by 5-10x."
    },
    {
      "id": "company_role_to_contact",
      "question": "Who at these companies should we look for?",
      "type": "single",
      "options": ["The owner / managing director", "Operations or admin manager (handles travel)", "HR (handles staff travel)", "Whoever — just give me a real human to reach"],
      "required": false,
      "rationale": "Travel buying decisions sit with different roles depending on company size. Picking the role steers our SERP queries."
    }
  ]
}

---

Query: "wedding planners in Lagos who handle Igbo weddings"
Reasonable output (audience and geography are pinned; budget tier is the open variable):
{
  "questions": [
    {
      "id": "wedding_budget_tier",
      "question": "Budget tier of weddings you want to focus on?",
      "type": "single",
      "options": ["Lower-mid (₦5-15M)", "Mid (₦15-50M)", "High-end (₦50M+)", "Any"],
      "required": false,
      "rationale": "Planner candidates differ sharply by budget tier — the high-end roster doesn't overlap with the mid market."
    },
    {
      "id": "planner_type",
      "question": "Solo / boutique planners or full-service firms?",
      "type": "single",
      "options": ["Solo / boutique (1-3 people)", "Mid firm (4-15)", "Full-service (15+)", "No preference"],
      "required": false,
      "rationale": "Solos are on Instagram; firms have proper websites — different sources to search."
    }
  ]
}

---

Query: "Heads of HR at Nigerian banks with more than 500 employees"
Reasonable output (every dimension already pinned — only an exemplar adds value):
{
  "questions": [
    {
      "id": "exemplar_targets",
      "question": "Any specific banks you'd point to as ideal targets?",
      "type": "text",
      "required": false,
      "placeholder": "e.g. GTBank, Access Bank, Zenith",
      "rationale": "Named exemplars anchor the candidate set when 'Nigerian banks > 500 staff' is otherwise just a long list."
    }
  ]
}

---

Notice how each example asks DIFFERENT questions in DIFFERENT registers, with slugs derived from THIS query's content (\`buyer_industry\`, \`wedding_budget_tier\`, \`planner_type\`, \`exemplar_targets\`) — not from a fixed schema. Match the register of the user's writing. The aviation user wrote informally; the banking user wrote precisely; respond in kind.

REMINDER: Output must be a single valid JSON object. Start with "{". End with "}".`;

/**
 * Scans text for the first balanced {...} block. Tolerant of prose before /
 * after the JSON and of strings that contain braces.
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
 * Generates the clarification checklist. The model decides whether questions
 * are needed — zero is a valid answer for already-specific queries.
 * Up to 2 attempts: initial call + one schema-fix retry if JSON is malformed.
 */
export async function generateClarifications(rawQuery: string): Promise<ClarificationQuestion[]> {
  if (!rawQuery.trim()) {
    throw ApiError.badRequest('rawQuery must not be empty');
  }

  // On technical failure (no JSON / schema mismatch), proceed without questions
  // rather than injecting generic fallbacks — a bad model response shouldn't
  // block the job or mislead the user with irrelevant questions.
  const bail = (reason: string, meta?: Record<string, unknown>): ClarificationQuestion[] => {
    console.warn(`[queryClarifier] ${reason}`, meta ?? {});
    return [];
  };

  const conversation: AiMessage[] = [{ role: 'user', content: rawQuery }];
  // Up to 2 attempts: (1) initial call, (2) schema-fix retry if JSON is malformed.
  // Zero questions is a valid model decision — no enforcement retry.
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await generateText(conversation, {
      systemPrompt: CLARIFIER_SYSTEM_PROMPT,
      cacheSystem: true,
      maxTokens: 1536,
      // Use CLARIFY_LLM_MODEL if set (prefer a fast model — clarifications
      // don't need discovery-quality reasoning). Fall back to DISCOVERY_LLM_MODEL.
      ...(env.USE_OPENROUTER && (env.CLARIFY_LLM_MODEL ?? env.DISCOVERY_LLM_MODEL)
        ? { model: env.CLARIFY_LLM_MODEL ?? env.DISCOVERY_LLM_MODEL }
        : {}),
    });

    const extracted = extractFirstJsonObject(response.text);
    if (!extracted) {
      if (attempt === MAX_ATTEMPTS) {
        return bail('no JSON object after max attempts', {
          rawResponsePreview: response.text.slice(0, 300),
        });
      }
      conversation.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'No JSON found. Respond with ONLY the JSON object. Start with "{" and end with "}".' },
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted);
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        return bail('invalid JSON after max attempts', {
          extractedPreview: extracted.slice(0, 300),
        });
      }
      conversation.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'Invalid JSON. Respond with ONLY a syntactically valid JSON object.' },
      );
      continue;
    }

    const result = LlmClarifyOutputSchema.safeParse(parsed);
    if (result.success) {
      return result.data.questions;
    }

    if (attempt === MAX_ATTEMPTS) {
      const issueSummary = result.error.issues
        .map((i) => `- path=${i.path.join('.') || '(root)'} code=${i.code} message=${i.message}`)
        .join('\n');
      return bail('schema failed after max attempts', {
        issues: issueSummary,
        parsedPreview: JSON.stringify(parsed).slice(0, 400),
      });
    }

    const issueSummary = result.error.issues
      .map((i) => `- path=${i.path.join('.') || '(root)'} code=${i.code} message=${i.message}`)
      .join('\n');
    conversation.push(
      { role: 'assistant', content: response.text },
      { role: 'user', content: `Schema validation failed:\n${issueSummary}\n\nRespond again with ONLY valid JSON matching the schema.` },
    );
  }

  // Loop should always return via one of the branches above, but TS
  // wants an exit.
  return bail('loop fell through (unreachable)');
}

