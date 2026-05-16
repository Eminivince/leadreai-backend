import { rateLimit } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getRedis } from '../config/redis.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const createRedisStore = (prefix: string) => new RedisStore({
  sendCommand: async (...args: string[]) => {
    const result = await getRedis().call(args[0]!, ...args.slice(1));
    return result as unknown as RedisReply;
  },
  prefix,
});

/**
 * Pass-through middleware used in development so local iteration
 * isn't throttled. Production still gets the real limiters.
 * Opt-in via RATE_LIMITS_ENABLED=true if you want to test rate-limit
 * behavior on localhost.
 */
const passthrough = (_req: Request, _res: Response, next: NextFunction): void => {
  next();
};

const RATE_LIMITS_ENABLED =
  env.NODE_ENV !== 'development' ||
  String(process.env['RATE_LIMITS_ENABLED'] ?? '').toLowerCase() === 'true';

if (!RATE_LIMITS_ENABLED) {
  logger.warn('[rateLimiter] rate limiting DISABLED for development. Set RATE_LIMITS_ENABLED=true to re-enable.');
}

/**
 * Auth rate limiter — counts FAILED attempts only. A successful login or
 * registration (2xx response) doesn't consume the budget. This protects
 * against brute-force password guessing without punishing legitimate users
 * who log in multiple times across devices, get their password right on
 * the second try, or re-register after realizing they already have an
 * account.
 *
 * Limit raised from 10 to 20 now that only the misses count — 20 failed
 * auth attempts in 15 minutes against a single IP is still clearly
 * adversarial.
 */
export const authRateLimiter = RATE_LIMITS_ENABLED
  ? rateLimit({
      store: createRedisStore('rl:auth:'),
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 20,
      skipSuccessfulRequests: true,
      message: {
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many failed auth attempts. Try again in 15 minutes.',
        },
      },
      standardHeaders: true,
      legacyHeaders: false,
    })
  : passthrough;

export const jobRateLimiter = RATE_LIMITS_ENABLED
  ? rateLimit({
      store: createRedisStore('rl:job:'),
      windowMs: 60 * 60 * 1000, // 1 hour
      max: env.JOB_RATE_LIMIT_PER_HOUR,
      message: {
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Job submission rate limit exceeded' },
      },
      standardHeaders: true,
      legacyHeaders: false,
    })
  : passthrough;

export const globalRateLimiter = RATE_LIMITS_ENABLED
  ? rateLimit({
      store: createRedisStore('rl:global:'),
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX_REQUESTS,
      message: {
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      },
      standardHeaders: true,
      legacyHeaders: false,
    })
  : passthrough;
