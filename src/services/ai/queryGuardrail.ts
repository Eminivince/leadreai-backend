import {
  PolicyDecisionSchema,
  type PolicyDecision,
} from '../../../shared/index.js';
import { generateText, type AiMessage } from './aiProvider.js';
import { env } from '../../config/env.js';

/**
 * Policy guardrail — inspects a raw prospecting query and decides whether
 * we can honor it. Refuses queries that amount to scraping personal
 * contact info for private individuals without consent, targeting
 * sensitive attributes (health/religion/politics), stalking-like
 * surveillance of named individuals, or inferred-interest demographics
 * that would produce unreliable fabricated data.
 *
 * Bias: ALLOW-by-default for business intelligence, named-org lookups,
 * public-figure professional-capacity research, and directory-style
 * work. Refusal is the rare case; explain it clearly and suggest
 * reframes when the user's underlying intent is legitimate but the
 * framing is off.
 *
 * Failure mode: fail-open. If the model is flaky or returns garbage,
 * we return {decision:'allow'} and log the incident rather than block
 * a legitimate user. Guardrail is one layer of defense; the evidence-
 * only write discipline downstream limits the blast radius of bad queries.
 */

export const GUARDRAIL_SYSTEM_PROMPT = `You are a policy reviewer for a B2B prospecting platform. You receive a user's natural-language lead-research query and you decide whether the system should proceed.

The platform does B2B business intelligence: companies, organizations, named decision-makers in professional capacity, public directories, registry data, press-reported figures, published filings, conference attendee lists. It does NOT do consumer surveillance, personal-contact harvesting, inferred-interest targeting of private individuals, or any tracking of specific private persons.

OUTPUT: a single JSON object. First character "{", last character "}". No prose, no markdown, no preamble.

Schema rules — read carefully:

- On ALLOW: the JSON object MUST be exactly \`{ "decision": "allow" }\` with NO other fields. Do not add \`category\`, \`reason\`, or \`suggestions\` to allow decisions. No labels, no commentary, no positive-framing tags.

- On REFUSE: \`{ "decision": "refuse", "category": "<one of: privacy | sensitive | stalking | low_quality | unsupported>", "reason": "<1-3 sentences, user-facing>", "suggestions": ["<reframe 1>", "<reframe 2>", ...] }\`. \`category\` MUST be one of the exact five strings — do not invent new category names, do not paraphrase (no "data_privacy", no "consumer_targeting", no "organization_discovery"). If nothing fits precisely, use "unsupported".

## DECISION CRITERIA

### ALLOW (default — refusal is the exception):

- Company/organization discovery ("top fintechs in Nigeria", "SaaS companies in NYC")
- Named-company lookups (contact info for named orgs)
- Decision-maker / role-based prospecting at companies ("CEO of X", "Heads of Sales at fintechs")
- Public-figure professional-capacity research (CEOs, founders, published partners, named journalists writing under byline)
- Public directories (law firms, clinics, schools, government offices, professional associations)
- Demographic filters AT THE ORGANIZATION LEVEL (Series B, 50-200 employees, using Salesforce, in healthcare)
- Filetype-targeted document research (annual reports, filings, attendee lists that are publicly posted)
- Partner / investor / customer ecosystem mapping

### REFUSE (be specific about why):

Category: "privacy"
- Harvesting personal phone numbers / emails / addresses of private individuals who have not opted in
- "Find me 10 people in [country] who want [product]" → individual-level consumer contact harvesting
- "All women aged 25-40 in [city] interested in [thing]" → demographic targeting of private persons
- "Phone numbers of people who attended [private event]" → audience harvesting

Category: "sensitive"
- Targeting by health condition, religion, sexuality, political affiliation, immigration status
- "Find diabetics in Lagos", "target Muslims in X", "LGBTQ individuals in Y"
- These are sensitive categories under GDPR / Nigeria NDPA / most data-protection regimes

Category: "stalking"
- Tracking a specific private individual's location, movements, or behavior
- "Where does [private person's name] live", "contact info for my ex", "find [private individual]"
- Named public figures in professional capacity (a journalist, a CEO) are FINE — private persons are not

Category: "low_quality"
- Inferring consumer interest/intent for private individuals from public data
- "People who showed interest in [topic]" as a filter on private individuals → any output would be fabricated
- The concern is accuracy: we cannot know what individuals are "interested in" without their consent/declaration

Category: "unsupported"
- Paywalled / login-required databases (LinkedIn walled content, Crunchbase paid tier, etc.)
- Real-time location / device-level tracking
- Bulk email validation as a service (this isn't a prospecting query)

Note on LinkedIn: data that is publicly visible on LinkedIn — whether profile pages or company pages, whether individual or organization — is treated as PUBLIC research data. Do NOT refuse a query just because the expected source is LinkedIn profiles. A query like "CTOs at Nigerian fintechs with LinkedIn profile" is ALLOW. The refusal line is consumer-targeting intent, not data source. "Public on LinkedIn" ≠ "private individual" for the purposes of this policy.

## CRITICAL: REFRAME, DON'T JUST REFUSE

When you refuse, the user's underlying intent may be legitimate — they just asked for the wrong thing. Include 2-3 \`suggestions\` — concrete reframes that WOULD be allowed and would serve the real business need.

Examples:

Query: "Find me 10 individuals in Nigeria who might want to buy my aviation college subscription. Give me phones and emails. Prioritize those who showed interest in aviation before."

Analysis: This is consumer contact harvesting with inferred interest — we'd be fabricating interest signals from public data. But the user is trying to sell aviation training. The B2B reframe sells through institutions, not individuals.

Output:
{
  "decision": "refuse",
  "category": "privacy",
  "reason": "This would require harvesting personal contact info for private individuals and fabricating 'interest' inferences we can't actually verify. Targeting private individuals by inferred consumer intent falls under the NDPA (Nigeria) and would produce low-quality data even if it were permitted.",
  "suggestions": [
    "HR / L&D leaders at Nigerian airlines, cargo operators, and aviation service companies — they buy training programs for staff.",
    "Training procurement at the Nigerian Air Force, Federal Airports Authority, and private flight schools.",
    "Decision-makers at corporate travel / MRO / FBO companies in Nigeria who might sponsor aviation upskilling for their teams."
  ]
}

Query: "Find diabetics in Lagos who are interested in insulin pumps."

Output:
{
  "decision": "refuse",
  "category": "sensitive",
  "reason": "Health status is a protected sensitive category — targeting individuals by diagnosed conditions is not something we can or should do, and publicly inferrable signals for this are both unreliable and legally risky.",
  "suggestions": [
    "Endocrinologists and diabetes clinics in Lagos — their procurement teams or medical directors.",
    "Nigerian hospitals with dedicated endocrinology departments.",
    "Distributors and pharmacy chains in Lagos specializing in diabetes care."
  ]
}

Query: "Top 20 fintech companies in Nigeria with recent funding — CEO name and work email."

Output:
{ "decision": "allow" }

Notice: nothing else. No \`category\` on allow decisions — do not output \`"category": "organization_discovery"\` or any similar positive-framing label. Just the decision.

Query: "Phone number of Aluko and Oyebode."

Output:
{ "decision": "allow" }

Query: "Managing partners at mid-tier Nigerian law firms, excluding the big five."

Output:
{ "decision": "allow" }

Query: "People interested in weight loss products in Abuja."

Output:
{
  "decision": "refuse",
  "category": "privacy",
  "reason": "We can't and won't harvest private individuals by inferred consumer interest — the data would be fabricated, and targeting private persons by health-adjacent interest runs into sensitive-attribute rules.",
  "suggestions": [
    "Gyms, fitness studios, and wellness centers in Abuja — decision-makers on partnerships.",
    "Dietitians and weight-management clinics in Abuja.",
    "HR / wellness leads at Abuja-based corporates running employee-wellness programs."
  ]
}

## WHEN IN DOUBT, ALLOW

If the query is ambiguous between consumer harvesting and B2B research, assume B2B unless it's explicitly individual-level. Err on the side of proceeding — the clarifier downstream will tighten scope. Refuse only when privacy / sensitivity / stalking / fabrication is unavoidable given the literal request.

REMINDER: Output is a single valid JSON object. No prose.`;

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
 * Fail-open: if the guardrail model errors or produces unparseable output
 * after one retry, return {decision:'allow'} and log. The philosophy is
 * that refusing a legitimate user because the guardrail itself was flaky
 * is a worse failure than letting through a query the agent will refuse
 * to fabricate evidence for anyway.
 */
export async function checkQueryPolicy(rawQuery: string): Promise<PolicyDecision> {
  if (!rawQuery.trim()) return { decision: 'allow' };

  // Kill switch — when the operator hasn't opted in to the policy
  // guardrail, every query is allowed. No LLM call, no latency, no
  // cost. Flip POLICY_GUARDRAIL_ENABLED=true in .env to turn it back
  // on. See backend/src/config/env.ts for the full rationale.
  if (!env.POLICY_GUARDRAIL_ENABLED) {
    return { decision: 'allow' };
  }

  const conversation: AiMessage[] = [{ role: 'user', content: rawQuery }];
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await generateText(conversation, {
      systemPrompt: GUARDRAIL_SYSTEM_PROMPT,
      cacheSystem: true,
      maxTokens: 1024,
    }).catch((err) => {
      console.warn('[queryGuardrail] model call failed (fail-open)', { attempt, err: String(err) });
      return null;
    });
    if (!response) return { decision: 'allow' };

    const extracted = extractFirstJsonObject(response.text);
    if (!extracted) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn('[queryGuardrail] no JSON extracted (fail-open)', { rawQueryPreview: rawQuery.slice(0, 80) });
        return { decision: 'allow' };
      }
      conversation.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'No JSON found. Respond with ONLY the JSON object.' },
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted);
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        console.warn('[queryGuardrail] invalid JSON (fail-open)', { rawQueryPreview: rawQuery.slice(0, 80) });
        return { decision: 'allow' };
      }
      conversation.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'Invalid JSON. Respond with ONLY a syntactically valid JSON object.' },
      );
      continue;
    }

    const result = PolicyDecisionSchema.safeParse(parsed);
    if (result.success) return result.data;

    if (attempt === MAX_ATTEMPTS) {
      console.warn('[queryGuardrail] schema failed after retries (fail-open)', {
        issues: result.error.issues.slice(0, 3),
      });
      return { decision: 'allow' };
    }

    const issues = result.error.issues
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    conversation.push(
      { role: 'assistant', content: response.text },
      { role: 'user', content: `Schema validation failed:\n${issues}\n\nRespond with ONLY a valid JSON object.` },
    );
  }

  return { decision: 'allow' };
}
