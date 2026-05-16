import type { ReplyClassification } from '../models/EmailEvent.js';

/**
 * Reply classifier (Task #16).
 *
 * Heuristic-only — no LLM call on the inbound hot path. Cost-bounded
 * by design: every inbound webhook delivery runs this once. The four
 * buckets are deliberately coarse because over-confident classification
 * is worse than honest "unknown" for an agency that still needs human
 * judgment.
 *
 * Order of precedence:
 *   1. bounce  — mailer-daemon style markers in From + subject + body.
 *   2. ooo     — out-of-office / auto-reply markers.
 *   3. positive — soft interest keywords.
 *   4. unknown  — everything else (default).
 *
 * Inputs are pulled from the inbound payload. Each provider's payload
 * shape is normalised by the caller (see `processInboundEmail`); this
 * function takes the post-normalised fields so it stays unit-testable
 * without provider-specific fixtures.
 */

export interface ClassifyInput {
  from?: string;
  subject?: string;
  bodyText?: string;
  /** Header bag, normalised to `{Name: 'Value', ...}` (any case). When
   *  the inbound payload only has raw text, the caller can pass a
   *  pre-parsed map here for richer signals (Auto-Submitted, X-Autoreply). */
  headers?: Record<string, string>;
}

const BOUNCE_FROM = /(mailer-?daemon|postmaster|bounces?@|noreply\.bounces|delivery-status)/i;
const BOUNCE_SUBJECT = /(undeliverable|delivery (status notification|failure)|returned mail|message not delivered|delivery has failed|address (?:rejected|invalid))/i;
const BOUNCE_BODY = /(550\s|552\s|recipient address rejected|user unknown|mailbox unavailable|no such user|delivery (?:to the following recipients failed|attempt has failed))/i;

const OOO_SUBJECT = /(out of (the )?office|on vacation|away (?:from|until)|maternity leave|paternity leave|sabbatical|on leave|autoreply|auto[- ]reply|automatic (?:reply|response))/i;
const OOO_BODY = /(out of (?:the )?office|currently away|on holiday|until further notice|i\b['’]?m on vacation|i'll be back|on leave until|will return on|reduced availability|limited (?:access|availability))/i;
const OOO_HEADER_KEYS = ['auto-submitted', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'precedence'];

const POSITIVE_BODY = /\b(interested|tell me more|let'?s (?:chat|talk|connect|schedule)|book a (?:call|demo|meeting)|sounds (?:good|great|interesting)|happy to (?:chat|connect|hear more)|would love to (?:chat|hear)|looking forward to|sign me up|please send|i'?m in\b|count me in)\b/i;
const NEGATIVE_BODY = /\b(not interested|unsubscribe|remove me|stop emailing|do not contact|please remove|take me off)\b/i;

export function classifyReply(input: ClassifyInput): ReplyClassification {
  const from = (input.from ?? '').toLowerCase();
  const subject = input.subject ?? '';
  const body = input.bodyText ?? '';
  const headers = input.headers ?? {};

  // 1. Bounce — strongest single signal is the From; subject / body
  //    only flips us when the From looks like an automated sender.
  if (BOUNCE_FROM.test(from)) return 'bounce';
  if (BOUNCE_SUBJECT.test(subject)) return 'bounce';
  if (BOUNCE_BODY.test(body)) return 'bounce';

  // 2. OOO — RFC-compliant senders set Auto-Submitted: auto-replied
  //    or Precedence: auto_reply. Combine with subject heuristic for
  //    senders that don't bother with headers.
  const autoSubmitted = (headers['auto-submitted'] ?? headers['Auto-Submitted'] ?? '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no' && autoSubmitted !== 'false') return 'ooo';
  for (const key of OOO_HEADER_KEYS) {
    if (headers[key] || headers[key.toLowerCase()]) {
      // Presence is enough for headers like X-Autoreply / X-Autorespond.
      if (key !== 'precedence') return 'ooo';
    }
  }
  const precedence = (headers['precedence'] ?? headers['Precedence'] ?? '').toLowerCase();
  if (precedence === 'auto_reply' || precedence === 'bulk') return 'ooo';
  if (OOO_SUBJECT.test(subject)) return 'ooo';
  if (OOO_BODY.test(body)) return 'ooo';

  // 3. Positive — only fires when there's NO negative-signal keyword
  //    in the same message. We'd rather mis-label a positive reply as
  //    "unknown" and let the human read it than wrongly flag a "not
  //    interested" as positive.
  if (POSITIVE_BODY.test(body) && !NEGATIVE_BODY.test(body)) return 'positive';

  return 'unknown';
}
