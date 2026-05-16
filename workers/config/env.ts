import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// See backend env for rationale — anchor storage path to the monorepo
// root so backend (writer) and worker (reader) see the same directory
// regardless of which cwd launched them.
const _moduleDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOCUMENTS_STORAGE_PATH = resolve(_moduleDir, '../../..', 'storage/documents');

// `z.coerce.boolean()` treats any non-empty string as true — including "false"
// and "0". This helper parses common boolean strings ("true"/"1"/"yes") properly.
const booleanFlag = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on';
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  CONTACT_ENRICHMENT_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017'),
  MONGODB_DB_NAME: z.string().default('leadreai'),
  SERPAPI_KEY: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  SERPER_API_KEY: z.string().optional(),
  // Comma-separated provider priority list. First configured + non-exhausted wins.
  SEARCH_PROVIDER_ORDER: z.string().default('brave,serper,serpapi'),
  SEARCH_CACHE_ENABLED: booleanFlag.default(true),
  SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).default(86400), // 24h
  PLAYWRIGHT_HEADLESS: booleanFlag.default(true),
  PLAYWRIGHT_TIMEOUT_MS: z.coerce.number().default(30000),
  PLAYWRIGHT_CONCURRENCY: z.coerce.number().default(3),
  MAX_FILE_DOWNLOAD_SIZE_MB: z.coerce.number().default(25),
  DEDUP_SIMILARITY_THRESHOLD: z.coerce.number().default(0.25),
  PROXY_LIST: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  // Local LiteLLM proxy — OpenAI-compatible endpoint on the user's machine.
  // When USE_LOCAL_LLM=true, all LLM calls route here instead of OpenRouter.
  USE_LOCAL_LLM: booleanFlag.default(false),
  LOCAL_LLM_BASE_URL: z.string().default('http://localhost:4400'),
  LOCAL_LLM_API_KEY: z.string().optional(),
  LOCAL_LLM_MODEL: z.string().default('qwen3.5'),
  OPENCORPORATES_API_KEY: z.string().optional(),
  REACHER_URL: z.string().url().optional(),
  EMAIL_VERIFIER_PROVIDER: z.enum(['mx_only', 'reacher']).default('mx_only'),
  // Hunter.io Domain Search — primary email source for contact enrichment.
  // When unset, the system falls back to web-scrape-only extraction (the
  // historical default). Free tier: 25 searches / 50 verifications per month.
  HUNTER_API_KEY: z.string().optional(),
  // Google Maps Places API — primary candidate source for businesses with
  // physical presence (restaurants, retail, services, SMEs). Single most
  // impactful unlock for the long-tail Nigerian-SME market: Maps indexes
  // every business that's ever been geo-tagged, including bukkas / mama
  // puts that have no web presence at all.
  // Get a key at: console.cloud.google.com → Places API → Enable.
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // Mandatory verification: when true, every email passes through verifyEmail()
  // at write time. Emails with verdict=undeliverable/invalid_domain are dropped;
  // verdict=likely_valid sets verified=true on the email entry.
  EMAIL_VERIFICATION_AT_WRITE: booleanFlag.default(true),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().default(5000),
  JWT_SECRET: z.string().min(32),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  UNSUBSCRIBE_BASE_URL: z.string().url().default('http://localhost:4000/unsubscribe'),
  UNSUBSCRIBE_TOKEN_SECRET: z.string().optional(),
  SEQUENCE_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(10000).default(60000),
  // Document library
  DOCUMENTS_STORAGE_PATH: z.string().default(DEFAULT_DOCUMENTS_STORAGE_PATH),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().default('https://api.openai.com/v1'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMS: z.coerce.number().default(1536),
  // Transcription (Whisper-style). Falls back to EMBEDDING_API_KEY /
  // EMBEDDING_BASE_URL when unset so one OpenAI key unlocks both.
  TRANSCRIPTION_API_KEY: z.string().optional(),
  TRANSCRIPTION_BASE_URL: z.string().optional(),
  TRANSCRIPTION_MODEL: z.string().default('whisper-1'),
  TRANSCRIPTION_MAX_MB: z.coerce.number().default(25),
  // Dev ergonomic — when true, drain every queue (active, waiting, delayed,
  // failed) at worker boot. BullMQ otherwise redelivers jobs that were
  // `active` when the previous process died (stalled-job recovery), which
  // is the right behavior in prod but means a fresh `pnpm dev` resurrects
  // the job you thought you killed. MUST stay false in prod — turning it
  // on there would wipe live jobs on every deploy.
  CLEAR_QUEUES_ON_BOOT: booleanFlag.default(false),
  // Pipeline mode selector. Three values:
  //   'old'    — dispatcher agent loop → parallel subagents (current prod default)
  //   'smart'  — Smart Discovery: parallel SERP → regex parse → one LLM contact call
  //   'hybrid' — single LLM discovery call → DNS/HTTP validation → parallel subagents
  // Keep AGENT_SMART_DISCOVERY and AGENT_FAN_OUT_ENABLED for backward-compat reads
  // in older code paths; routing now controlled solely by DISCOVERY_MODE.
  DISCOVERY_MODE: z.enum(['old', 'smart', 'hybrid']).default('hybrid'),
  // Override the LLM model for the hybrid discovery call only.
  // Falls back to OPENROUTER_MODEL when unset.
  // The discovery step needs a model that reliably outputs structured JSON;
  // the default nemotron model is broken for this use case.
  // Recommended: google/gemini-2.0-flash-exp:free or meta-llama/llama-3.3-70b-instruct:free
  DISCOVERY_LLM_MODEL: z.string().optional(),
  // Judgment model — used for the critic (replan/continue/stop decisions in the
  // agent loop) and lead qualification (qualified/dust/score/reason). These are
  // genuine reasoning tasks where v4-pro's hidden chain-of-thought earns its
  // latency cost. The high-volume mechanical calls (tool dispatch, JSON
  // extraction, per-company enrichment) keep using the fast OPENROUTER_MODEL.
  // Falls back to OPENROUTER_MODEL when unset.
  JUDGMENT_LLM_MODEL: z.string().optional(),
  AGENT_SMART_DISCOVERY: booleanFlag.default(false),
  AGENT_FAN_OUT_ENABLED: booleanFlag.default(true),
  // Keep low (2-3) when using free-tier OpenRouter models — they have a 20 req/min
  // rate limit that 5 concurrent subagents exhaust immediately, causing constant
  // 429 backoff that makes each subagent take 3-4x longer.
  SUBAGENT_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  FAN_OUT_MIN_TARGET: z.coerce.number().int().min(1).max(50).default(5),
  // Code sandbox — Python executor for agent data-processing tasks.
  // Requires Docker installed and the sandbox image built:
  //   docker build -t leadreai-sandbox:latest workers/sandbox/
  SANDBOX_ENABLED: booleanFlag.default(false),
  SANDBOX_IMAGE: z.string().default('leadreai-sandbox:latest'),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().min(5000).default(30_000),
  SANDBOX_MEMORY_MB: z.coerce.number().int().min(64).default(256),
  // Sentry — mirror of backend env shape so the same DSN can be reused
  // across services. When unset, the workers' sentry init is a no-op.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid worker env variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
