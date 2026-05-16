import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Redis-backed cache for parsed file content. Keyed by sha256(url)
 * so two agents searching the same dork don't re-download + re-parse
 * the same PDF.
 *
 * TTL: 24h by default. Values are JSON-serialized ParsedFile records
 * (see fileExtractor.ts) — chunks + tables + extracted contacts.
 * A single cached file can be large (megabytes of chunked text); we
 * keep it in Redis rather than Mongo so a full workspace flush is
 * one EXPIREAT away and nothing leaks cross-tenant.
 */

const DEFAULT_TTL_SECONDS = 60 * 60 * 24;
const KEY_PREFIX = 'file:parsed';

let _redis: Redis | null = null;
function redis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    _redis.on('error', (err) =>
      logger.warn('[fileCache] redis error', {
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return _redis;
}

export function cacheKeyForUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

function redisKey(cacheKey: string): string {
  return `${KEY_PREFIX}:${cacheKey}`;
}

export interface CachedFileValue {
  url: string;
  value: unknown; // ParsedFile — kept as unknown here so fileExtractor can import from us, not us from it
  createdAt: number;
}

export async function getCachedFile<T>(url: string): Promise<T | null> {
  const cacheKey = cacheKeyForUrl(url);
  try {
    const raw = await redis().get(redisKey(cacheKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedFileValue;
    return parsed.value as T;
  } catch (err) {
    logger.warn('[fileCache] read failed', {
      url,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function setCachedFile<T>(url: string, value: T, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  const cacheKey = cacheKeyForUrl(url);
  const payload: CachedFileValue = { url, value, createdAt: Date.now() };
  try {
    await redis().set(redisKey(cacheKey), JSON.stringify(payload), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('[fileCache] write failed', {
      url,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Separate key for addressing a cached file by its hash (what the agent
 * gets back from fetch_file), rather than by URL. Used by
 * get_file_chunk so the agent can page through a file it already
 * parsed without needing to resend the URL.
 */
export async function getCachedFileByKey<T>(cacheKey: string): Promise<T | null> {
  try {
    const raw = await redis().get(redisKey(cacheKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedFileValue;
    return parsed.value as T;
  } catch {
    return null;
  }
}
