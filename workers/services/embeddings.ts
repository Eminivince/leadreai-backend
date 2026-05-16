import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { recordEmbeddingCost } from './costTracker.js';

/* ─────────────────────────────────────────────────────────────────
 * Embedding client.
 *
 * Uses the OpenAI SDK with a configurable base URL — works against
 * OpenAI, any OpenAI-compatible gateway (OpenRouter has limited
 * embeddings support; self-hosted LiteLLM + sentence-transformers
 * works well), and swaps providers with a single env flip.
 *
 * If EMBEDDING_API_KEY is unset we return null from embedOne — the
 * calling worker knows to mark the document as ready-without-embed.
 * The agent tool's read_document then gracefully returns no hits,
 * but document upload + parse still work, so users can drop files
 * in and connect embeddings later.
 * ───────────────────────────────────────────────────────────────── */

let _client: OpenAI | null = null;

export function isEmbeddingConfigured(): boolean {
  return !!env.EMBEDDING_API_KEY;
}

function client(): OpenAI {
  if (!_client) {
    if (!env.EMBEDDING_API_KEY) {
      throw new Error('EMBEDDING_API_KEY is not configured');
    }
    _client = new OpenAI({ apiKey: env.EMBEDDING_API_KEY, baseURL: env.EMBEDDING_BASE_URL });
  }
  return _client;
}

function truncate(text: string, maxChars = 8000): string {
  // text-embedding-3-* accepts ~8192 tokens (~32KB of English). We cap
  // at ~8000 chars, which is safely under the token limit for all
  // reasonable languages and avoids the round-trip of tokenization here.
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export async function embedOne(text: string): Promise<number[] | null> {
  if (!isEmbeddingConfigured()) return null;
  const trimmed = truncate(text.trim());
  if (!trimmed) return null;

  try {
    const res = await client().embeddings.create({
      model: env.EMBEDDING_MODEL,
      input: trimmed,
    });
    const vec = res.data?.[0]?.embedding;
    if (!vec) return null;
    // Cost — OpenAI / compatible providers return token count on `usage`.
    // Fall back to a character-based estimate if absent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = (res as any)?.usage;
    const tokens = typeof usage?.total_tokens === 'number'
      ? usage.total_tokens
      : Math.ceil(trimmed.length / 4); // ~4 chars/token heuristic
    void recordEmbeddingCost('openai', tokens, undefined, env.EMBEDDING_MODEL);
    return vec;
  } catch (err) {
    logger.warn('[embeddings] embedOne failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Embed many texts in one API call. Batch size 64 keeps us under
 * OpenAI's per-request limits and makes the backoff blast radius
 * small if we hit a rate limit.
 */
export async function embedBatch(texts: string[]): Promise<Array<number[] | null>> {
  if (!isEmbeddingConfigured() || texts.length === 0) return texts.map(() => null);

  const BATCH = 64;
  const out: Array<number[] | null> = new Array(texts.length).fill(null);

  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH).map(truncate);
    try {
      const res = await client().embeddings.create({
        model: env.EMBEDDING_MODEL,
        input: slice,
      });
      for (let j = 0; j < slice.length; j += 1) {
        const vec = res.data?.[j]?.embedding;
        out[i + j] = vec ?? null;
      }
      // Cost — one record per batch, tokens summed across the batch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usage = (res as any)?.usage;
      const tokens = typeof usage?.total_tokens === 'number'
        ? usage.total_tokens
        : Math.ceil(slice.reduce((acc, s) => acc + s.length, 0) / 4);
      void recordEmbeddingCost('openai', tokens, undefined, env.EMBEDDING_MODEL);
    } catch (err) {
      logger.warn('[embeddings] embedBatch chunk failed', {
        batchStart: i,
        batchSize: slice.length,
        err: err instanceof Error ? err.message : String(err),
      });
      // leave the slice as null — caller treats missing embedding as
      // "this chunk won't be searchable" without crashing the whole job
    }
  }

  return out;
}

/** Cosine similarity between two same-length vectors. Returns 0 on length mismatch. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
