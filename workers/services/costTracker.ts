import mongoose, { Schema } from 'mongoose';
import type { CostCategory } from '../../shared/index.js';
import { logger } from '../utils/logger.js';
import { getCostContext, type CostContext } from './costContext.js';

/**
 * Cost tracker (workers-side mirror of backend/src/services/cost/tracker.ts).
 *
 * Must stay in lockstep with backend — same collection name, same fields,
 * same pricing logic. We duplicate rather than cross-import because the
 * worker process can't reach the backend's Express-bound config.
 *
 * Pricing constants are inlined here (copied from
 * backend/src/config/pricing.ts). When the pricing table changes, update
 * BOTH files. Tests could enforce this later; for now it's a convention.
 *
 * Fire-and-forget: a failed cost write never crashes the surrounding
 * operation. We'd rather lose a cost event than break a customer-facing
 * tool call over telemetry.
 */

// ── Inline Mongoose model (workers pattern — strict:false for flexibility) ──
const costEventSchema = new Schema(
  {
    workspaceId: Schema.Types.ObjectId,
    jobId: Schema.Types.ObjectId,
    campaignId: Schema.Types.ObjectId,
    category: String,
    provider: String,
    model: String,
    units: {
      input: Number, output: Number, cached: Number,
      count: Number, bytes: Number, seconds: Number,
    },
    unitPriceUSD: Schema.Types.Mixed,
    totalCostUSD: Number,
    occurredAt: Date,
    meta: Schema.Types.Mixed,
  },
  { strict: false },
);
// Rename `model` → `modelSlug` to avoid collision with Mongoose's Document.model.
costEventSchema.add({ modelSlug: String });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CostEventModel: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['CostEvent'] as mongoose.Model<any> | undefined) ??
  mongoose.model('CostEvent', costEventSchema, 'costevents');

// ── Pricing (mirror of backend/src/config/pricing.ts) ──
interface LlmPricing { inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number }

const LLM_PRICING: Record<string, LlmPricing> = {
  'openrouter/anthropic/claude-sonnet-4-6':  { inputPer1M: 3.00,  outputPer1M: 15.00, cacheReadPer1M: 0.30 },
  'openrouter/anthropic/claude-opus-4-7':    { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50 },
  'openrouter/anthropic/claude-haiku-4-5':   { inputPer1M: 1.00,  outputPer1M: 5.00,  cacheReadPer1M: 0.10 },
  'openrouter/openai/gpt-4o-mini':           { inputPer1M: 0.15,  outputPer1M: 0.60 },
  'openrouter/openai/gpt-4o':                { inputPer1M: 2.50,  outputPer1M: 10.00 },
  'local':                                    { inputPer1M: 0,     outputPer1M: 0 },
};
const UNKNOWN_LLM_PRICING: LlmPricing = { inputPer1M: 5.00, outputPer1M: 20.00 };

const SERP_PRICING: Record<string, { perCall: number }> = {
  serpapi: { perCall: 0.015 },
  serper:  { perCall: 0.001 },
  brave:   { perCall: 0.000 },
};

const FILE_FETCH = { perMBBandwidth: 0.000, perParse: 0.0002 };
const TRANSCRIPTION_PER_MINUTE = 0.006;
const SCRAPE_PER_CALL = 0.002;
const EMBEDDING_PER_1M = 0.02;

// ── Core writer ──
interface BaseContext {
  workspaceId: string | mongoose.Types.ObjectId;
  jobId?: string | mongoose.Types.ObjectId;
  campaignId?: string | mongoose.Types.ObjectId;
  meta?: Record<string, unknown>;
}

/**
 * Resolves the ctx passed by a caller, falling back to AsyncLocalStorage.
 * Most workers set costContext at the job boundary and every tracker call
 * inside the loop elides the ctx arg. Callers that have explicit context
 * (campaigns outside the agent loop) still pass it directly.
 */
function resolveCtx(explicit?: Partial<BaseContext>): BaseContext | null {
  const als = getCostContext();
  if (explicit?.workspaceId) {
    return {
      workspaceId: explicit.workspaceId,
      jobId: explicit.jobId ?? als?.jobId,
      campaignId: explicit.campaignId ?? als?.campaignId,
      meta: explicit.meta,
    };
  }
  if (als) {
    return {
      workspaceId: als.workspaceId,
      jobId: als.jobId,
      campaignId: als.campaignId,
      meta: explicit?.meta,
    };
  }
  return null;
}

function toObjectId(v: string | mongoose.Types.ObjectId | undefined): mongoose.Types.ObjectId | undefined {
  if (!v) return undefined;
  return typeof v === 'string' ? new mongoose.Types.ObjectId(v) : v;
}

// Re-export for callers that want to set the scope.
export { runWithCostContext } from './costContext.js';
export type { CostContext };

async function write(
  category: CostCategory,
  provider: string,
  explicitCtx: Partial<BaseContext> | undefined,
  totalCostUSD: number,
  units: Record<string, number | undefined>,
  unitPriceUSD: Record<string, number> | undefined,
  modelSlug?: string,
): Promise<void> {
  try {
    const ctx = resolveCtx(explicitCtx);
    if (!ctx) return; // no scope set — dev script / unit test. Silently drop.
    const workspaceId = toObjectId(ctx.workspaceId);
    if (!workspaceId) return;
    const compactUnits: Record<string, number> = {};
    for (const [k, v] of Object.entries(units)) {
      if (typeof v === 'number' && v >= 0) compactUnits[k] = v;
    }
    await CostEventModel.create({
      workspaceId,
      jobId: toObjectId(ctx.jobId),
      campaignId: toObjectId(ctx.campaignId),
      category, provider, modelSlug,
      units: compactUnits,
      unitPriceUSD,
      totalCostUSD,
      occurredAt: new Date(),
      meta: ctx.meta,
    });
  } catch (err) {
    logger.warn('[costTracker] write failed (non-fatal)', {
      category, provider,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Per-category public API ──
// All `ctx` params are OPTIONAL — falls back to AsyncLocalStorage when
// a worker has established a cost scope via runWithCostContext.
export async function recordLlmCost(
  model: string,
  units: { input?: number; output?: number; cached?: number },
  ctx?: Partial<BaseContext>,
  provider = 'openrouter',
): Promise<void> {
  const pricing = LLM_PRICING[model] ?? UNKNOWN_LLM_PRICING;
  const cacheReadPrice = pricing.cacheReadPer1M ?? pricing.inputPer1M;
  const input = units.input ?? 0;
  const output = units.output ?? 0;
  const cached = units.cached ?? 0;
  const totalUSD =
    (input / 1_000_000) * pricing.inputPer1M +
    (cached / 1_000_000) * cacheReadPrice +
    (output / 1_000_000) * pricing.outputPer1M;
  await write('llm', provider, ctx, totalUSD, units, pricing as unknown as Record<string, number>, model);
}

export async function recordSerpCost(provider: string, ctx?: Partial<BaseContext>): Promise<void> {
  const pricing = SERP_PRICING[provider] ?? { perCall: 0.005 };
  await write('serp', provider, ctx, pricing.perCall, { count: 1 }, pricing as unknown as Record<string, number>);
}

export async function recordFileFetchCost(provider: string, bytes: number, ctx?: Partial<BaseContext>): Promise<void> {
  const mb = bytes / (1024 * 1024);
  const totalUSD = mb * FILE_FETCH.perMBBandwidth + FILE_FETCH.perParse;
  await write('file_fetch', provider, ctx, totalUSD, { bytes, count: 1 }, FILE_FETCH as unknown as Record<string, number>);
}

export async function recordTranscriptionCost(provider: string, seconds: number, ctx?: Partial<BaseContext>): Promise<void> {
  const minutes = seconds / 60;
  const totalUSD = minutes * TRANSCRIPTION_PER_MINUTE;
  await write('transcription', provider, ctx, totalUSD, { seconds, count: 1 }, { perMinute: TRANSCRIPTION_PER_MINUTE });
}

export async function recordScrapeCost(provider: string, ctx?: Partial<BaseContext>): Promise<void> {
  await write('scrape', provider, ctx, SCRAPE_PER_CALL, { count: 1 }, { perCall: SCRAPE_PER_CALL });
}

export async function recordEmbeddingCost(
  provider: string,
  tokens: number,
  ctx?: Partial<BaseContext>,
  model?: string,
): Promise<void> {
  const totalUSD = (tokens / 1_000_000) * EMBEDDING_PER_1M;
  await write('embedding', provider, ctx, totalUSD, { input: tokens }, { per1MTokens: EMBEDDING_PER_1M }, model);
}
