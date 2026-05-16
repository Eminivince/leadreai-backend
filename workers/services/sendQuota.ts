import type { Redis } from 'ioredis';

/**
 * Per-workspace daily send quota, backed by a Redis INCR counter with a
 * 25-hour TTL (key lifetime > one calendar day to survive DST / leap-second
 * edge cases). Keyed by YYYY-MM-DD in the workspace's configured timezone
 * so "daily cap" means the customer's day, not UTC.
 *
 * Race behavior: INCR is atomic; if the new value exceeds the cap, we
 * roll back with DECR. Under heavy contention we may briefly over-count
 * by at most (concurrency − 1) before rolling back — bounded and
 * acceptable for a cap that exists to prevent domain-reputation damage,
 * not to enforce an exact SLA.
 */

function dateKeyInTz(tz: string, now: Date = new Date()): string {
  // en-CA yields YYYY-MM-DD natively.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export interface QuotaCheckResult {
  allowed: boolean;
  used: number;      // count after this call, or rolled-back value if blocked
  cap: number;
}

const TTL_SECONDS = 25 * 60 * 60; // 25h — rolls over before next day's key is needed

export async function reserveSend(params: {
  redis: Redis;
  workspaceId: string;
  timezone: string;
  cap: number;
  now?: Date;
}): Promise<QuotaCheckResult> {
  const { redis, workspaceId, timezone, cap } = params;
  const key = `send-quota:${workspaceId}:${dateKeyInTz(timezone, params.now)}`;

  const count = await redis.incr(key);
  if (count === 1) {
    // First write of the day — set TTL. If EXPIRE fails (e.g. AOF replay
    // quirk), the key would be permanent; unlikely but not fatal — the
    // worst case is a stuck counter that's fixable by manual DEL.
    await redis.expire(key, TTL_SECONDS).catch(() => {});
  }

  if (count > cap) {
    // Roll back — we didn't actually use a send slot.
    await redis.decr(key).catch(() => {});
    return { allowed: false, used: count - 1, cap };
  }
  return { allowed: true, used: count, cap };
}

/** Read-only check — no INCR. For preflight / dashboard surfaces. */
export async function peekQuotaUsage(params: {
  redis: Redis;
  workspaceId: string;
  timezone: string;
  now?: Date;
}): Promise<number> {
  const { redis, workspaceId, timezone } = params;
  const key = `send-quota:${workspaceId}:${dateKeyInTz(timezone, params.now)}`;
  const val = await redis.get(key);
  return val ? parseInt(val, 10) || 0 : 0;
}
