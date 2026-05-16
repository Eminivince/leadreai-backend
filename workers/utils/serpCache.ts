import { Redis } from 'ioredis';
import { logger } from './logger.js';
import type { SerpResult } from '../pipeline/serpScraper.js';

const CACHE_TTL_SECONDS = 7200; // 2 hours

export class SerpCache {
  private readonly redis: Redis;
  private readonly keyPrefix = 'serp:links';

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private key(jobId: string): string {
    return `${this.keyPrefix}:${jobId}`;
  }

  /** Push links to the tail of the queue (RPUSH). Resets TTL. */
  async addLinks(jobId: string, links: SerpResult[]): Promise<void> {
    if (links.length === 0) return;
    const k = this.key(jobId);
    await this.redis.rpush(k, ...links.map(l => JSON.stringify(l)));
    await this.redis.expire(k, CACHE_TTL_SECONDS);
    logger.debug('[SerpCache] addLinks', { jobId, added: links.length });
  }

  /** Pop up to `batchSize` links from the head of the queue in a single round trip. */
  async getNextBatch(jobId: string, batchSize: number): Promise<SerpResult[]> {
    const k = this.key(jobId);
    // lpop with count pops N items in one round trip (Redis 6.2+, ioredis supports it)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raws: string[] | null = await (this.redis as any).lpop(k, batchSize);
    if (!raws) return [];
    const batch: SerpResult[] = [];
    for (const raw of raws) {
      try {
        batch.push(JSON.parse(raw) as SerpResult);
      } catch {
        logger.warn('[SerpCache] Failed to parse cached link', { jobId });
      }
    }
    return batch;
  }

  /** Number of links remaining in cache. */
  async size(jobId: string): Promise<number> {
    return this.redis.llen(this.key(jobId));
  }

  /** Remove cache for a job (call when job completes or fails). */
  async clear(jobId: string): Promise<void> {
    await this.redis.del(this.key(jobId));
  }
}
