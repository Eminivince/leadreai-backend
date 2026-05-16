import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

let _initialised = false;

/**
 * Initialise Sentry exactly once if a DSN is configured. Called from
 * `backend/src/index.ts` and `workers/src/index.ts` before any handler
 * runs. Without a DSN this is a deliberate no-op so dev / test setups
 * can keep ignoring Sentry entirely — the wire-up is fully env-gated.
 */
export function initSentry(serviceTag: 'backend' | 'workers'): void {
  if (_initialised) return;
  if (!env.SENTRY_DSN) {
    logger.info('[sentry] SENTRY_DSN not set — error tracking disabled', { service: serviceTag });
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // Tag every event with which service emitted it so the dashboard can
    // filter backend vs workers without combing through breadcrumbs.
    initialScope: { tags: { service: serviceTag } },
  });

  _initialised = true;
  logger.info('[sentry] initialised', {
    service: serviceTag,
    environment: env.NODE_ENV,
    release: env.SENTRY_RELEASE ?? '(unset)',
  });
}

/**
 * Forward an error to Sentry if it's initialised. Centralises the
 * "is Sentry on?" check so call sites don't have to repeat it.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!_initialised) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
