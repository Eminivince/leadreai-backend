import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Zod's built-in `z.coerce.boolean()` uses JS Boolean(string), so any non-empty
 * string — including "false", "0", "no" — coerces to `true`. That's a footgun
 * for feature flags from .env. This helper parses the common human-readable
 * boolean strings correctly.
 */
const booleanFlag = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on';
  });

// Anchor the default storage path to the monorepo root so it's stable
// regardless of which package's cwd launched the process. Both backend
// and worker env.ts files compute the same absolute path this way,
// which means uploads written by backend are readable by worker.
// Layout: <repo>/<pkg>/src/config/env.ts → three levels up is the repo root.
const _moduleDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOCUMENTS_STORAGE_PATH = resolve(_moduleDir, '../../..', 'storage/documents');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB_NAME: z.string().default('leadreai'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
  USE_GOOGLE: booleanFlag.default(false),
  USE_OPENROUTER: booleanFlag.default(false),
  USE_LOCAL_LLM: booleanFlag.default(false),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().default(2048),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_MODEL: z.string().default('gemini-2.0-flash-lite'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  // Override the LLM model for discovery + clarification calls (both use the same
  // model so questions are generated with the same domain context as company discovery).
  // Falls back to OPENROUTER_MODEL when unset.
  DISCOVERY_LLM_MODEL: z.string().optional(),
  LOCAL_LLM_BASE_URL: z.string().default('http://localhost:4400'),
  LOCAL_LLM_API_KEY: z.string().optional(),
  LOCAL_LLM_MODEL: z.string().default('qwen3.5'),
  SERPAPI_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().email().default('outreach@leadreai.app'),
  FROM_NAME: z.string().default('LeadreAI'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_TO_MONGODB: booleanFlag.default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  JOB_RATE_LIMIT_PER_HOUR: z.coerce.number().default(10),
  // Policy guardrail toggle. When true, every query goes through
  // checkQueryPolicy() and may be refused (privacy / sensitive /
  // stalking / low_quality / unsupported categories). When false or
  // unset, the guardrail short-circuits to `{decision:'allow'}` and
  // every query proceeds straight to the clarifier.
  //
  // Default is false (OFF) so bare-bones setups take any query. Flip to
  // true in production once you've decided on the policy posture.
  POLICY_GUARDRAIL_ENABLED: booleanFlag.default(false),
  WORKER_CONCURRENCY: z.coerce.number().default(3),
  ADMIN_SECRET: z.string().min(16).optional(),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  SYSTEM_FROM_EMAIL: z.string().email().default('hello@leadreai.local'),
  SYSTEM_FROM_NAME: z.string().default('LeadreAI'),
  DOCUMENTS_STORAGE_PATH: z.string().default(DEFAULT_DOCUMENTS_STORAGE_PATH),
  DOCUMENTS_MAX_UPLOAD_MB: z.coerce.number().default(25),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().default('https://api.openai.com/v1'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMS: z.coerce.number().default(1536),
  CREDITS_PER_JOB: z.coerce.number().int().min(0).default(1),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().default(5000),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  SENDGRID_WEBHOOK_SECRET: z.string().optional(),
  UNSUBSCRIBE_BASE_URL: z.string().url().default('http://localhost:4000/unsubscribe'),
  UNSUBSCRIBE_TOKEN_SECRET: z.string().min(16).optional(),
  SEQUENCE_MAX_SENDS_PER_MINUTE: z.coerce.number().int().min(1).default(50),
  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID_GROWTH: z.string().optional(),
  // Paystack — secret key is used for both API calls and webhook HMAC (no separate webhook secret)
  // Optional fast model override for clarifying-question generation.
  // Clarifications don't need discovery-quality reasoning — use a fast model
  // (e.g. deepseek/deepseek-chat, meta-llama/llama-3.3-70b-instruct:free)
  // to cut first-token latency from ~8s to ~1-2s. Falls back to DISCOVERY_LLM_MODEL.
  CLARIFY_LLM_MODEL: z.string().optional(),
  // Strong judgment model — used for the intent parser (one call per job
  // where misreads cascade into the entire pipeline running on the wrong
  // target). Falls back to OPENROUTER_MODEL when unset. Mirrors the same
  // env var the workers use for the critic + lead qualifier.
  JUDGMENT_LLM_MODEL: z.string().optional(),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PAYSTACK_PLAN_CODE_GROWTH: z.string().optional(),
  PAYSTACK_CURRENCY: z.string().default('ngn'),
  PAYSTACK_NGN_RATE: z.coerce.number().default(1600),
  // Sentry — when SENTRY_DSN is set we initialise the SDK at boot. Without
  // it the init helpers are no-ops, so this is safe to leave unset in
  // local dev. Release tag is optional; falls back to git SHA if injected
  // by CI (`vercel build` and the GitHub Actions runner both expose this).
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
