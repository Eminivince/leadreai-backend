import type { ParsedIntent } from '../../shared/index.js';

export interface DiscoveryPromptInput {
  parsedIntent: ParsedIntent;
  rawQuery: string;
  clarifications?: Array<{ id: string; question: string; answer: unknown }>;
}

/**
 * Pulls exclusion clauses from the user's free text + clarifications.
 *
 * We've observed that exclusions like "no household names", "excluding X",
 * "not big-five", "outside aggregators" get silently ignored when they're
 * embedded in a multi-sentence brief. Listing them in a dedicated HARD
 * EXCLUSIONS section of the prompt forces the model to commit to honoring
 * them. The regex below catches the common surface forms.
 */
function extractExclusions(
  rawQuery: string,
  clarifications?: Array<{ id: string; question: string; answer: unknown }>,
): string[] {
  const found: string[] = [];

  const sentences = rawQuery.split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const lower = s.toLowerCase();
    // Forms: "no <thing>", "no <thing> or <thing>", "not <thing>"
    const noMatch = lower.match(/\bno\s+([^.,;]{3,80})/);
    if (noMatch && noMatch[1] && !/\bcredit card\b/.test(noMatch[1])) {
      found.push(s);
      continue;
    }
    // Forms: "excluding X", "exclude X", "without X", "outside X"
    if (/\b(excluding|exclude|without|outside|except|other than)\b/.test(lower)) {
      found.push(s);
      continue;
    }
    // Forms: "not <thing>", "avoid <thing>"
    if (/\b(avoid|skip)\b/.test(lower)) {
      found.push(s);
      continue;
    }
    // Forms: "I don't want X", "we wouldn't consider X", "I do not want X".
    // Common in conversational briefs ("I dont want big companies"). The
    // earlier extractor missed these because they don't start with "no" /
    // "exclude" / "avoid" — they're verb-phrase exclusions.
    if (/\b(don'?t|do not|won'?t|wouldn'?t|cannot|can'?t)\s+(want|like|need|use|consider|take|accept)\b/.test(lower)) {
      found.push(s);
      continue;
    }
    // Forms: "just small / only small / strictly small" — these are
    // positive constraints that imply "not big". Catch the common
    // small-company / non-popular phrasings so they reach the LLM as
    // hard constraints.
    if (/\b(just|only|strictly)\s+(small|tiny|micro|local|under-the-radar|lesser-known|upcoming|mid-market)\b/.test(lower)) {
      found.push(s);
      continue;
    }
    if (/\b(small|tiny|local|lesser-known|upcoming|mid-market|under-the-radar|not popular|not big|not famous|not established|not prominent|household name)\b/.test(lower)) {
      found.push(s);
      continue;
    }
  }

  // Pick up explicit clarification answers like "What kind of lead would be WRONG?"
  if (clarifications) {
    for (const c of clarifications) {
      const q = c.question.toLowerCase();
      if (/\b(disqualif|wrong|exclude|avoid|bad fit|reject)\b/.test(q)) {
        const ans = Array.isArray(c.answer) ? (c.answer as unknown[]).join(', ') : String(c.answer ?? '');
        if (ans.trim()) found.push(ans.trim().slice(0, 200));
      }
    }
  }

  // De-dupe while preserving order, cap at 6 items so the prompt stays focused
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of found) {
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Builds the single-call discovery prompt for the hybrid pipeline.
 *
 * Design goals:
 * - The model draws on training knowledge only — no tool calls, no iteration.
 * - fitReason must reference concrete company attributes, not generic praise.
 * - The model is instructed to OMIT rather than pad — underdelivering is better
 *   than hallucinating a company that doesn't exist.
 * - Output is raw JSON only, no prose, no markdown fences.
 */
export function buildDiscoveryPrompt({ parsedIntent, rawQuery, clarifications }: DiscoveryPromptInput): string {
  const {
    industry,
    geography,
    targetCount,
    companySize,
    keywords,
    queryType,
    namedEntities,
    userOffering,
  } = parsedIntent;

  const geo = [geography?.city, geography?.state, geography?.country]
    .filter(Boolean)
    .join(', ');

  const sections: string[] = [];

  sections.push(`You are a B2B market research assistant. Your task is to propose a list of real companies that match a prospecting brief.`);
  sections.push(``);
  sections.push(`## Brief`);
  sections.push(`Original query: "${rawQuery}"`);
  if (industry) sections.push(`Industry: ${industry}${parsedIntent.subIndustry ? ` / ${parsedIntent.subIndustry}` : ''}`);
  if (geo) sections.push(`Geography: ${geo}`);
  if (companySize) sections.push(`Company size: ${companySize}`);
  if (keywords?.length) sections.push(`Keywords: ${keywords.join(', ')}`);
  if (queryType === 'named_entity_list' && namedEntities?.length) {
    sections.push(`Named entities to resolve: ${namedEntities.join(', ')}`);
  }
  if (userOffering) {
    sections.push(`What the searcher is selling: ${userOffering}`);
  }
  if (clarifications && clarifications.length > 0) {
    sections.push(`User clarifications (treat as hard constraints):`);
    for (const c of clarifications) {
      const answer = Array.isArray(c.answer) ? (c.answer as unknown[]).join(', ') : String(c.answer ?? '');
      if (answer.trim()) sections.push(`  - ${c.question}: ${answer}`);
    }
  }
  sections.push(`Requested count: ${targetCount} companies`);

  // HARD CONSTRAINTS — extract exclusions from the brief and put them in
  // their own section. The model has been observed silently ignoring "no
  // household names" / "exclude X" / "not Y" framings when they're buried
  // inside a multi-sentence query. Surfacing them as a dedicated block
  // forces the model to commit to honoring them.
  const exclusions = extractExclusions(rawQuery, clarifications);
  if (exclusions.length > 0) {
    sections.push(``);
    sections.push(`## HARD EXCLUSIONS — DO NOT IGNORE`);
    sections.push(`The brief explicitly excludes the following. Any candidate matching these is INVALID and must be omitted, even if it would otherwise fit. After drafting your candidate list, re-read it and remove any that violate these.`);
    for (const e of exclusions) {
      sections.push(`  ✗ ${e}`);
    }
  }

  sections.push(``);
  sections.push(`## Output format`);
  sections.push(`Return ONLY a JSON object like this example (adapt to the actual brief above):`);
  sections.push(`{
  "candidates": [
    {
      "name": "Paystack",
      "domain": "paystack.com",
      "description": "Nigerian fintech company processing online payments for thousands of businesses across Africa, acquired by Stripe in 2020.",
      "fitReason": "Paystack has 200+ employees distributed across Lagos and remote locations and regularly flies staff to conferences and client meetings. Their rapid post-acquisition headcount growth means they now manage significant corporate travel spend without a dedicated travel management solution.",
      "confidence": "high",
      "signals": ["200+ staff", "post-acquisition growth", "distributed team"],
      "likelyContact": {
        "name": "Shola Akinlade",
        "title": "CEO & Co-founder",
        "sourceHint": "widely reported in tech press 2016-present"
      }
    }
  ]
}`);

  sections.push(``);
  sections.push(`## Rules`);
  sections.push(`- Return ONLY the JSON object. No markdown fences, no preamble, no explanation.`);
  sections.push(`- "domain" must be the root domain only: no https://, no www., no paths. Use null when the company genuinely has no website (small SMEs, bukkas, mama puts, sole-proprietor businesses often don't). NEVER fabricate a domain — null is far better than a guessed URL that won't resolve. The downstream pipeline finds web/social footprint via search for these cases.`);
  sections.push(`- "confidence" reflects how certain you are this company exists and matches the brief:`);
  sections.push(`    high = you are certain this company exists and fits`);
  sections.push(`    medium = you believe it exists but are less sure of the fit`);
  sections.push(`    low = you are guessing`);
  sections.push(`- "signals" are 1-3 short tags that justify the fit: e.g. "Series A 2023", "50-200 staff", "rapid hiring", "Nigeria HQ", "corporate clients".`);
  sections.push(`- OMIT any company you are not confident exists. Do NOT invent domains. Do NOT pad to hit the requested count if you don't have enough confident candidates.`);
  sections.push(`- HONOR HARD EXCLUSIONS. Re-read your candidate list before emitting it. For every entry, ask: "does this violate any HARD EXCLUSION?" If yes, drop it and do not replace. Returning fewer companies that match the brief is far better than returning more that don't. The user notices excluded matches immediately and loses trust.`);
  sections.push(`- COUNTERACT YOUR RETRIEVAL BIAS. Your training data heavily over-represents prominent companies — multinationals, the largest local players, Big-Four professional services firms, state-owned enterprises, household-name industrials, internationally recognized NGOs. When the brief asks for "small / upcoming / mid-market / non-blue-chip / lesser-known / not-popular / normal daily / under-the-radar" companies, those prominent names are exactly the WRONG answer, even though they're the easiest for you to recall. Apply this self-check to every candidate: "Would a typical informed reader in the target market immediately recognize this company by name? Does it regularly appear in international or national press? Is it among the top 10 in its sector by size or visibility?" If any answer is yes AND the brief excludes prominent companies, drop the candidate. Pick less-prominent matches even when your confidence in their existence is lower — that's the correct trade-off for this kind of brief.`);
  sections.push(`- fitReason MUST be specific to this company. Generic statements like "they could benefit from better tools" are rejected.`);
  if (userOffering) {
    sections.push(`- fitReason MUST explain why this company specifically would buy or need: "${userOffering}".`);
  }
  sections.push(`- If namedEntities were provided, prioritise resolving those first before adding others.`);
  sections.push(`- "likelyContact" is OPTIONAL. The role you target depends entirely on the brief above — read the original query and clarifications, then pick the appropriate persona. It might be a founder/CEO for general decision-maker prospecting, but could equally be Head of HR (if the user is selling to HR), VP Sales (selling sales tools), CTO/Head of Engineering (selling dev tools), procurement/operations director (selling supplies), Head of Marketing (selling marketing tools), or any other role the brief implies. Include "likelyContact" ONLY when you can name a specific person at the company in the role the brief asks for, and you are highly confident about both the person AND their current role. Do NOT guess. Do NOT default to founder/CEO when the user's brief points elsewhere. Hallucinated names are worse than missing names — skip the field freely.`);
  sections.push(`- "sourceHint" describes WHERE the user could verify the contact name (e.g. "tech press", "LinkedIn", "company About page"). Free-text, not a URL.`);

  sections.push(``);
  sections.push(`Respond with the JSON object now.`);

  return sections.join('\n');
}
