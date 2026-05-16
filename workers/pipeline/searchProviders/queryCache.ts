import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { SearchEngine, SearchResultItem } from './types.js';

/**
 * Query-result cache. Keys are deterministic hashes of (engine + query). TTL
 * is configurable via env (default 24h).
 *
 * Why this matters: most prospecting queries repeat across users and jobs.
 * "fintech companies in Nigeria" today isn't different from the same query
 * yesterday. Every cache hit is one fewer paid API call. In typical usage
 * patterns this reduces real spend by 60-80%.
 *
 * The router is responsible for calling `get` before invoking providers and
 * `set` after a successful provider response.
 */

const KEY_PREFIX = 'search:query:';

function makeKey(engine: SearchEngine, query: string): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const hash = createHash('sha1').update(`${engine}\0${normalized}`).digest('hex').slice(0, 16);
  return `${KEY_PREFIX}${engine}:${hash}`;
}

export class SearchQueryCache {
  constructor(private readonly redis: Redis) {}

  async get(engine: SearchEngine, query: string): Promise<SearchResultItem[] | null> {
    if (!env.SEARCH_CACHE_ENABLED) return null;
    try {
      const raw = await this.redis.get(makeKey(engine, query));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SearchResultItem[];
      if (!Array.isArray(parsed)) return null;
      logger.debug('[searchCache] hit', { engine, query: query.slice(0, 60), count: parsed.length });
      return parsed;
    } catch (err) {
      logger.warn('[searchCache] get failed', { err: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async set(engine: SearchEngine, query: string, results: SearchResultItem[]): Promise<void> {
    if (!env.SEARCH_CACHE_ENABLED) return;
    if (results.length === 0) return; // don't cache empties — often transient
    try {
      const key = makeKey(engine, query);
      await this.redis.set(key, JSON.stringify(results), 'EX', env.SEARCH_CACHE_TTL_SECONDS);
      logger.debug('[searchCache] set', { engine, query: query.slice(0, 60), count: results.length, ttl: env.SEARCH_CACHE_TTL_SECONDS });
    } catch (err) {
      logger.warn('[searchCache] set failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }
}

// Module-level singleton — created lazily on first use. We open our own Redis
// connection rather than threading one through every search callsite; the
// cache is a small-volume, non-blocking consumer so a dedicated connection
// avoids contention with the BullMQ workers' connections.
let _redis: Redis | null = null;
let _instance: SearchQueryCache | null = null;

export function getQueryCache(): SearchQueryCache {
  if (!_instance) {
    _redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    _redis.on('error', (err) => logger.warn('[searchCache] redis error', { err: err.message }));
    _instance = new SearchQueryCache(_redis);
  }
  return _instance;
}
