import { logger } from '../utils/logger.js';
import { callLlm, isLlmConfigured } from '../utils/llmClient.js';

export interface ContactCandidate {
  name?: string;
  title?: string;
  department?: string;
  email?: string;
  phone?: string;
  confidence: number;
  reasoning?: string;
  sourceType: 'structured_data' | 'staff_card' | 'contact_block' | 'body_text' | 'regex_fallback';
}

export interface ExtractInput {
  url: string;
  domain: string;
  bodyText: string;
  jsonLd?: unknown[];
  rawEmails: string[];
  rawPhones: string[];
  entityHint?: string;
}

const AI_TIMEOUT_MS = 12_000;
const MAX_TEXT_CHARS = 8_000;

const SYSTEM_PROMPT = `You extract real business contact data from scraped web pages.

You will receive:
- The page URL and domain
- Cleaned body text (first ~8k characters)
- Structured data from JSON-LD tags (schema.org Organization, Person, ContactPoint)
- Raw regex hits for emails and phones (may include noise, false positives, placeholders)
- An optional entity hint (the company we are researching)

Return a JSON object: { "contacts": [ContactCandidate, ...] }

Each ContactCandidate may include: name, title, department, email, phone, confidence (0-1), reasoning (one short phrase), sourceType (one of: structured_data, staff_card, contact_block, body_text, regex_fallback).

RULES:
- Only emit contacts where the data appears to be REAL and ASSOCIATED WITH THE COMPANY on this page.
- Reject placeholders: example.com, test@, firstname.lastname@, your@email.com, code-snippet strings.
- Reject noise prefixes: noreply, no-reply, bounce, newsletter, mailer-daemon, unsubscribe, privacy, legal, billing, hr, marketing, abuse, postmaster.
- Prefer named contacts (with title/name) over generic mailboxes. A CEO with name and email gets confidence 0.9+; a generic info@ gets 0.5-0.6.
- If the page is clearly a directory/list page featuring multiple organizations, only emit contacts that belong to the hinted entity (if given). Otherwise emit the most prominent company's contacts.
- If you cannot find any real contacts, return { "contacts": [] }.
- Return ONLY JSON, no markdown, no code fences.`;

function buildUserPrompt(input: ExtractInput): string {
  const text = input.bodyText.slice(0, MAX_TEXT_CHARS);
  const jsonLd = input.jsonLd && input.jsonLd.length > 0
    ? JSON.stringify(input.jsonLd).slice(0, 3000)
    : 'none';
  return `URL: ${input.url}
Domain: ${input.domain}
Entity hint: ${input.entityHint ?? 'none'}

Regex-matched emails (hints, may contain noise): ${input.rawEmails.slice(0, 30).join(', ') || 'none'}
Regex-matched phones (hints, may contain noise): ${input.rawPhones.slice(0, 30).join(', ') || 'none'}

JSON-LD structured data: ${jsonLd}

Page body text:
${text}`;
}

function fallbackFromHints(input: ExtractInput): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  for (const email of input.rawEmails.slice(0, 10)) {
    out.push({ email, confidence: 0.4, sourceType: 'regex_fallback' });
  }
  for (const phone of input.rawPhones.slice(0, 10)) {
    out.push({ phone, confidence: 0.4, sourceType: 'regex_fallback' });
  }
  return out;
}

export async function extractContacts(input: ExtractInput): Promise<ContactCandidate[]> {
  if (!isLlmConfigured()) {
    return fallbackFromHints(input);
  }
  if (!input.bodyText.trim() && input.rawEmails.length === 0 && input.rawPhones.length === 0) {
    return [];
  }

  try {
    const content = await callLlm({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      max_tokens: 1200,
      temperature: 0,
      response_format: { type: 'json_object' },
      timeoutMs: AI_TIMEOUT_MS,
    });

    const parsed = JSON.parse(content || '{}') as { contacts?: ContactCandidate[] };
    const contacts = Array.isArray(parsed.contacts) ? parsed.contacts : [];

    const cleaned = contacts
      .filter(c => c && (c.email || c.phone || c.name))
      .map(c => ({
        ...c,
        confidence: Math.max(0, Math.min(1, Number(c.confidence ?? 0.5))),
        sourceType: c.sourceType ?? 'body_text',
      }));

    logger.info('[aiContactExtractor] extracted', {
      domain: input.domain,
      count: cleaned.length,
      rawEmails: input.rawEmails.length,
      rawPhones: input.rawPhones.length,
    });
    return cleaned;
  } catch (err) {
    logger.warn('[aiContactExtractor] extraction failed — using regex fallback', {
      domain: input.domain,
      err: err instanceof Error ? err.message : String(err),
    });
    return fallbackFromHints(input);
  }
}
