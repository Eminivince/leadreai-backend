import { getRedis } from '../../config/redis.js';
import type { DataSource } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Per-workspace per-source rate limiting via Redis INCR counters.
 *
 * Same shape as the send-quota counter in workers/src/services/sendQuota.ts:
 * atomic INCR, DECR rollback on block. Worst-case over-count bounded by
 * concurrency — acceptable for rate limiting that exists to protect
 * external providers from our own bursts.
 *
 * Keys:
 *   ratelimit:ds:{workspaceId}:{dataSourceId}:min:{unix-minute}
 *   ratelimit:ds:{workspaceId}:{dataSourceId}:day:{yyyy-mm-dd-utc}
 */

export interface RateLimitResult {
  allowed: boolean;
  window?: 'minute' | 'day';
  limit?: number;
  used?: number;
}

function minuteBucket(now = new Date()): string {
  return String(Math.floor(now.getTime() / 60_000));
}
function dayBucket(now = new Date()): string {
  // UTC day — rate-limit buckets are provider-facing and providers don't
  // care about workspace timezone. Different from send-quota which is
  // customer-visible daily cap (that's in workspace tz).
  return now.toISOString().slice(0, 10);
}

export async function reserveRateLimit(
  ds: DataSource,
  workspaceId: string,
): Promise<RateLimitResult> {
  if (!ds.rateLimit) return { allowed: true };
  const redis = getRedis();
  const { perMinute, perDay } = ds.rateLimit;

  // Minute bucket first (tighter).
  if (perMinute) {
    const key = `ratelimit:ds:${workspaceId}:${ds.id}:min:${minuteBucket()}`;
    try {
      const val = await redis.incr(key);
      if (val === 1) await redis.expire(key, 90).catch(() => {}); // 90s so it spans tick boundaries
      if (val > perMinute) {
        await redis.decr(key).catch(() => {});
        return { allowed: false, window: 'minute', limit: perMinute, used: val - 1 };
      }
    } catch (err) {
      logger.warn('[rateLimit] minute bucket read/write failed — fail-open', {
        dataSourceId: ds.id,
        err: err instanceof Error ? err.message : String(err),
      });
      // Fail-open — we'd rather let a legitimate call through than block
      // on a Redis hiccup.
    }
  }

  if (perDay) {
    const key = `ratelimit:ds:${workspaceId}:${ds.id}:day:${dayBucket()}`;
    try {
      const val = await redis.incr(key);
      if (val === 1) await redis.expire(key, 25 * 3600).catch(() => {});
      if (val > perDay) {
        await redis.decr(key).catch(() => {});
        return { allowed: false, window: 'day', limit: perDay, used: val - 1 };
      }
    } catch (err) {
      logger.warn('[rateLimit] day bucket read/write failed — fail-open', {
        dataSourceId: ds.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { allowed: true };
}
