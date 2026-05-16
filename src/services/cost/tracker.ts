import mongoose from 'mongoose';
import CostEvent from '../../models/CostEvent.js';
import type { CostCategory } from '../../../shared/index.js';
import {
  computeLlmCost,
  computeSerpCost,
  computeFileFetchCost,
  computeTranscriptionCost,
  computeScrapeCost,
  computeEmbeddingCost,
  computeEmailSendCost,
} from '../../config/pricing.js';
import { logger } from '../../utils/logger.js';

/**
 * Cost tracker (backend-side). The workers have their own mirror at
 * `workers/src/services/costTracker.ts` — same shape, same collection,
 * but without importing Express-side deps. Keep them in lockstep.
 *
 * Tracker is deliberately fire-and-forget by default: every caller awaits
 * a Promise that never rejects. A failed cost write should never break
 * the surrounding operation — we'd rather lose a cost event than fail
 * a customer-facing action over telemetry.
 */

interface BaseContext {
  workspaceId: string | mongoose.Types.ObjectId;
  jobId?: string | mongoose.Types.ObjectId;
  campaignId?: string | mongoose.Types.ObjectId;
  meta?: Record<string, unknown>;
}

function toObjectId(v: string | mongoose.Types.ObjectId | undefined): mongoose.Types.ObjectId | undefined {
  if (!v) return undefined;
  return typeof v === 'string' ? new mongoose.Types.ObjectId(v) : v;
}

async function write(
  category: CostCategory,
  provider: string,
  ctx: BaseContext,
  totalCostUSD: number,
  units: Record<string, number | undefined>,
  priceSnapshot: Record<string, number> | undefined,
  modelSlug?: string,
): Promise<void> {
  try {
    const workspaceId = toObjectId(ctx.workspaceId);
    if (!workspaceId) {
      logger.warn('[cost] write skipped — missing workspaceId', { category, provider });
      return;
    }
    const compactUnits: Record<string, number> = {};
    for (const [k, v] of Object.entries(units)) {
      if (typeof v === 'number' && v >= 0) compactUnits[k] = v;
    }
    await CostEvent.create({
      workspaceId,
      jobId: toObjectId(ctx.jobId),
      campaignId: toObjectId(ctx.campaignId),
      category,
      provider,
      modelSlug,
      units: compactUnits,
      unitPriceUSD: priceSnapshot,
      totalCostUSD,
      occurredAt: new Date(),
      meta: ctx.meta,
    });
  } catch (err) {
    logger.warn('[cost] write failed (non-fatal)', {
      category, provider,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function recordLlmCost(
  model: string,
  units: { input?: number; output?: number; cached?: number },
  ctx: BaseContext,
  provider = 'openrouter',
): Promise<void> {
  const { totalUSD, priceSnapshot } = computeLlmCost(model, units);
  await write(
    'llm', provider, ctx, totalUSD,
    { ...units },
    priceSnapshot as unknown as Record<string, number>,
    model,
  );
}

export async function recordSerpCost(provider: string, ctx: BaseContext): Promise<void> {
  const { totalUSD, priceSnapshot } = computeSerpCost(provider);
  await write('serp', provider, ctx, totalUSD, { count: 1 }, priceSnapshot as unknown as Record<string, number>);
}

export async function recordFileFetchCost(
  provider: string, // e.g. 'axios' | 'pdf-parse' | 'xlsx'
  bytes: number,
  ctx: BaseContext,
): Promise<void> {
  const { totalUSD, priceSnapshot } = computeFileFetchCost(bytes);
  await write('file_fetch', provider, ctx, totalUSD, { bytes, count: 1 }, priceSnapshot as unknown as Record<string, number>);
}

export async function recordTranscriptionCost(
  provider: string,
  seconds: number,
  ctx: BaseContext,
): Promise<void> {
  const { totalUSD, priceSnapshot } = computeTranscriptionCost(seconds);
  await write('transcription', provider, ctx, totalUSD, { seconds, count: 1 }, priceSnapshot as unknown as Record<string, number>);
}

export async function recordScrapeCost(
  provider: string, // e.g. 'playwright'
  ctx: BaseContext,
): Promise<void> {
  const { totalUSD, priceSnapshot } = computeScrapeCost();
  await write('scrape', provider, ctx, totalUSD, { count: 1 }, priceSnapshot as unknown as Record<string, number>);
}

export async function recordEmbeddingCost(
  provider: string, // e.g. 'openai' | 'openrouter'
  tokens: number,
  ctx: BaseContext,
  model?: string,
): Promise<void> {
  const { totalUSD, priceSnapshot } = computeEmbeddingCost(tokens);
  await write('embedding', provider, ctx, totalUSD, { input: tokens }, priceSnapshot as unknown as Record<string, number>, model);
}

export async function recordEmailSendCost(
  provider: string, // 'resend' | 'sendgrid' | 'gmail' | 'smtp'
  ctx: BaseContext,
): Promise<void> {
  const { totalUSD, priceSnapshot } = computeEmailSendCost(provider);
  await write('email_send', provider, ctx, totalUSD, { count: 1 }, priceSnapshot as unknown as Record<string, number>);
}
