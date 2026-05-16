import type { Request, Response } from 'express';
import { generateText, type AiMessage } from '../services/ai/aiProvider.js';
import { ApiError } from '../utils/ApiError.js';
import { PATRA_KNOWLEDGE } from '../data/patraKnowledge.js';

/* ─────────────────────────────────────────────────────────────────
 * Patra — the LeadreAI AI assistant.
 *
 * PATRA_KNOWLEDGE is the authoritative platform documentation.
 * It is embedded at compile time so no file I/O is needed at runtime.
 * Anthropic prompt caching (cacheSystem: true) means the first request
 * in a 5-minute window pays full token cost; subsequent ones pay ~10%.
 * ───────────────────────────────────────────────────────────────── */

const PATRA_SYSTEM_PROMPT = `You are **Patra**, the AI assistant built into LeadreAI.

The following is the complete, authoritative platform documentation. Use it as your ground truth. Never invent features, settings, or integrations that are not described here.

${PATRA_KNOWLEDGE}

---

## Response rules

- Be concise and direct. No filler phrases ("Great question!", "Certainly!").
- Use Markdown — bold, headers, bullet lists — responses are rendered as formatted text.
- Short questions get short answers. Don't pad with unnecessary context.
- When writing email copy, write actual copy the user can use, not instructions to write it.
- When navigating the user somewhere, give the exact path (e.g. Settings → Billing & usage).
- If something the user asks about isn't in the documentation above, say so plainly. Don't guess.`;

export async function patraChat(req: Request, res: Response) {
  const messages: AiMessage[] = req.body.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw ApiError.badRequest('messages must be a non-empty array');
  }
  if (messages.some((m) => !m.role || !m.content || typeof m.content !== 'string')) {
    throw ApiError.badRequest('each message must have role and content');
  }
  if (messages.length > 40) {
    throw ApiError.badRequest('conversation exceeds maximum length');
  }

  // Abort the upstream fetch if the client disconnects before the LLM responds.
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    const result = await generateText(messages, {
      systemPrompt: PATRA_SYSTEM_PROMPT,
      maxTokens: 1024,
      forceProvider: 'openrouter',
      signal: abort.signal,
    });

    if (res.headersSent) return;
    res.json({ success: true, data: { reply: result.text } });
  } catch (err) {
    // Client closed the connection — not an error worth logging.
    if (abort.signal.aborted || (err instanceof Error && err.message === 'terminated')) return;
    throw err;
  }
}
