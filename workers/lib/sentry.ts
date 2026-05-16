import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

let _initialised = false;

/** See `backend/src/lib/sentry.ts` — same contract, separate Sentry
 *  instance so backend + workers don't share rate-limit budgets. */
export function initSentry(): void {
  if (_initialised) return;
  if (!env.SENTRY_DSN) {
    logger.info('[sentry] SENTRY_DSN not set — error tracking disabled', { service: 'workers' });
    return;
  }
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    initialScope: { tags: { service: 'workers' } },
  });
  _initialised = true;
  logger.info('[sentry] initialised', { service: 'workers' });
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!_initialised) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
