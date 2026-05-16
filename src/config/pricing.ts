/**
 * Pricing table — per-unit costs in USD, frozen at event-emit time.
 *
 * We store the computed `totalCostUSD` on every CostEvent AND we store
 * the `unitPriceUSD` that was used. So changing a price here affects
 * future events only; historical reporting stays accurate at the
 * then-current price. This is deliberate — retroactive reprice is rarely
 * what you want for billing / customer receipts.
 *
 * When a provider changes pricing, update this file and commit. Future
 * spending gets re-priced automatically; the git history doubles as a
 * pricing-change audit trail.
 *
 * NOT priced here: human time, fixed hosting cost, Redis / Mongo storage.
 * Those are overheads amortized into margin, not per-event cost-of-goods.
 */

export interface LlmPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Cached-read tokens are typically 10% of input price. Omit to fall
   *  back to input price when provider doesn't report cache-read separately. */
  cacheReadPer1M?: number;
}

export interface SerpProviderPricing {
  perCall: number;
}

export interface FileFetchPricing {
  perMBBandwidth: number;
  /** Amortized worker CPU for PDF/DOCX/XLSX parsing. */
  perParse: number;
}

export interface TranscriptionPricing {
  perMinute: number;
}

export interface ScrapePricing {
  /** Amortized Playwright container cost per call. */
  perCall: number;
}

export interface EmbeddingPricing {
  per1MTokens: number;
}

export interface EmailSendPricing {
  /** Per-message provider fee — amortized across Resend / SendGrid / Gmail.
   *  Gmail OAuth is technically free for app-level sends but we still emit
   *  an event so daily-cap analytics + send-rate dashboards work regardless
   *  of provider mix. */
  perSend: number;
}

/**
 * LLM models we route through. Match the canonical `provider/model` slug
 * the caller passes to `callLlm`. Unknown models fall back to
 * `UNKNOWN_LLM_PRICING` with a warning logged — the cost tracker still
 * records the event, just with a pessimistic placeholder price.
 */
export const LLM_PRICING: Record<string, LlmPricing> = {
  // OpenRouter → Anthropic
  'openrouter/anthropic/claude-sonnet-4-6':  { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30 },
  'openrouter/anthropic/claude-opus-4-7':    { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50 },
  'openrouter/anthropic/claude-haiku-4-5':   { inputPer1M: 1.00, outputPer1M: 5.00, cacheReadPer1M: 0.10 },
  // OpenRouter → OpenAI
  'openrouter/openai/gpt-4o-mini':           { inputPer1M: 0.15, outputPer1M: 0.60 },
  'openrouter/openai/gpt-4o':                { inputPer1M: 2.50, outputPer1M: 10.00 },
  // Local / self-hosted (free at inference time)
  'local':                                    { inputPer1M: 0, outputPer1M: 0 },
};

/** Fallback when an LLM event comes in for a model we haven't priced. */
export const UNKNOWN_LLM_PRICING: LlmPricing = { inputPer1M: 5.00, outputPer1M: 20.00 };

export const SERP_PRICING: Record<string, SerpProviderPricing> = {
  serpapi: { perCall: 0.015 },
  serper:  { perCall: 0.001 },
  brave:   { perCall: 0.000 },
};

export const FILE_FETCH_PRICING: FileFetchPricing = {
  perMBBandwidth: 0.000,  // negligible at our scale today; reserved for future CDN billing
  perParse:       0.0002, // amortized worker CPU for PDF/OCR parse
};

export const TRANSCRIPTION_PRICING: TranscriptionPricing = {
  perMinute: 0.006, // Whisper-compat self-hosted or third-party rate
};

export const SCRAPE_PRICING: ScrapePricing = {
  perCall: 0.002, // amortized Playwright container cost
};

export const EMBEDDING_PRICING: EmbeddingPricing = {
  per1MTokens: 0.02, // text-embedding-3-small rate
};

export const EMAIL_SEND_PRICING: Record<string, EmailSendPricing> = {
  resend:   { perSend: 0.0004 }, // ~$0.40 / 1k transactional (Resend pay-as-you-go)
  sendgrid: { perSend: 0.0008 }, // SendGrid Essentials tier amortized
  gmail:    { perSend: 0.0000 }, // user's own Google Workspace quota — no per-send fee
  smtp:     { perSend: 0.0000 }, // self-hosted; cost rolled into infra
};
export const UNKNOWN_EMAIL_PRICING: EmailSendPricing = { perSend: 0.0010 };

/**
 * Compute LLM cost from token counts. Returns `{ totalUSD, priceSnapshot }`
 * where priceSnapshot is the `{inputPer1M, outputPer1M, cacheReadPer1M}`
 * used, so the CostEvent can preserve it.
 */
export function computeLlmCost(
  model: string,
  units: { input?: number; output?: number; cached?: number },
): { totalUSD: number; priceSnapshot: LlmPricing } {
  const pricing = LLM_PRICING[model] ?? UNKNOWN_LLM_PRICING;
  const input = units.input ?? 0;
  const output = units.output ?? 0;
  const cached = units.cached ?? 0;
  const cacheReadPrice = pricing.cacheReadPer1M ?? pricing.inputPer1M;

  const totalUSD =
    (input / 1_000_000) * pricing.inputPer1M +
    (cached / 1_000_000) * cacheReadPrice +
    (output / 1_000_000) * pricing.outputPer1M;

  return { totalUSD, priceSnapshot: pricing };
}

export function computeSerpCost(provider: string): { totalUSD: number; priceSnapshot: SerpProviderPricing } {
  const pricing = SERP_PRICING[provider] ?? { perCall: 0.005 };
  return { totalUSD: pricing.perCall, priceSnapshot: pricing };
}

export function computeFileFetchCost(bytes: number): { totalUSD: number; priceSnapshot: FileFetchPricing } {
  const mb = bytes / (1024 * 1024);
  const totalUSD = mb * FILE_FETCH_PRICING.perMBBandwidth + FILE_FETCH_PRICING.perParse;
  return { totalUSD, priceSnapshot: FILE_FETCH_PRICING };
}

export function computeTranscriptionCost(seconds: number): { totalUSD: number; priceSnapshot: TranscriptionPricing } {
  const minutes = seconds / 60;
  return { totalUSD: minutes * TRANSCRIPTION_PRICING.perMinute, priceSnapshot: TRANSCRIPTION_PRICING };
}

export function computeScrapeCost(): { totalUSD: number; priceSnapshot: ScrapePricing } {
  return { totalUSD: SCRAPE_PRICING.perCall, priceSnapshot: SCRAPE_PRICING };
}

export function computeEmbeddingCost(tokens: number): { totalUSD: number; priceSnapshot: EmbeddingPricing } {
  const totalUSD = (tokens / 1_000_000) * EMBEDDING_PRICING.per1MTokens;
  return { totalUSD, priceSnapshot: EMBEDDING_PRICING };
}

export function computeEmailSendCost(provider: string): { totalUSD: number; priceSnapshot: EmailSendPricing } {
  const pricing = EMAIL_SEND_PRICING[provider] ?? UNKNOWN_EMAIL_PRICING;
  return { totalUSD: pricing.perSend, priceSnapshot: pricing };
}
