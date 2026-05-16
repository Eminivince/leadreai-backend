import { z } from 'zod';

/**
 * Cost tracking — per-action receipts that let customers answer "what did
 * this cost us?" and give us the billing-telemetry foundation.
 *
 * Categories are deliberately narrow. Each maps to a concrete external
 * spend (LLM tokens, SERP calls, etc.) or an amortized internal cost
 * (scrape container CPU, PDF-parse worker time). When adding a new
 * category, update the pricing table AND the tracker instrumentation
 * in the same PR — an uncategorized spend is worse than no spend tracking.
 */
export const COST_CATEGORIES = [
  'llm',           // per-call LLM usage — tokens in/out/cached, keyed by model
  'serp',          // per-call SERP provider hit
  'file_fetch',    // per-file download + parse (PDF, DOCX, XLSX, OCR)
  'transcription', // per-minute audio transcription
  'scrape',        // per-call Playwright/headless render
  'embedding',     // per-token embedding calls (Library ingest, read_document)
  'email_send',    // per-outbound email (Resend/SendGrid/Gmail/SMTP)
] as const;

export const CostCategorySchema = z.enum(COST_CATEGORIES);
export type CostCategory = z.infer<typeof CostCategorySchema>;

/**
 * Unit counters for a single cost event. Which fields populate depends on
 * category:
 *   llm:           input, output, cached (tokens)
 *   serp:          count (always 1 per event; kept for future batch semantics)
 *   file_fetch:    bytes, count (1 per file)
 *   transcription: seconds
 *   scrape:        count (1 per call)
 *   embedding:     input (tokens)
 *
 * Extra units don't break anything — they're stored and ignored by the
 * aggregator for categories that don't use them.
 */
export const CostUnitsSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cached: z.number().nonnegative().optional(),
  count: z.number().nonnegative().optional(),
  bytes: z.number().nonnegative().optional(),
  seconds: z.number().nonnegative().optional(),
});

export const CostEventSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  jobId: z.string().optional(),
  campaignId: z.string().optional(),
  category: CostCategorySchema,
  provider: z.string().min(1).max(80),
  modelSlug: z.string().max(200).optional(),
  units: CostUnitsSchema,
  /** Unit price at the moment of emission, in USD. Stored per-event so
   *  retroactive pricing changes don't silently rewrite historical cost.
   *  Shape varies by category; the aggregator handles the math. */
  unitPriceUSD: z.record(z.string(), z.number()).optional(),
  totalCostUSD: z.number().nonnegative(),
  occurredAt: z.string(), // ISO
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type CostEvent = z.infer<typeof CostEventSchema>;

/**
 * Per-category subtotals for a job. Denormalized onto ProspectingJob so
 * the job detail page reads the total without aggregating events.
 */
export const JobCostSummarySchema = z.object({
  totalUSD: z.number().nonnegative(),
  byCategory: z.record(CostCategorySchema, z.number().nonnegative()),
  eventCount: z.number().int().nonnegative(),
  // ISO — the last time the aggregator ran. Prevents stale reads from
  // lagging behind late-arriving events (e.g. async file caches).
  computedAt: z.string().optional(),
});
export type JobCostSummary = z.infer<typeof JobCostSummarySchema>;

/**
 * Full breakdown response from GET /jobs/:id/cost — what the UI consumes.
 * `events` is capped server-side; the full log ships via the CSV export.
 */
export const JobCostBreakdownSchema = z.object({
  jobId: z.string(),
  summary: JobCostSummarySchema,
  byProvider: z.array(
    z.object({
      category: CostCategorySchema,
      provider: z.string(),
      modelSlug: z.string().optional(),
      totalUSD: z.number().nonnegative(),
      eventCount: z.number().int().nonnegative(),
      units: CostUnitsSchema,
    }),
  ),
  recentEvents: z.array(CostEventSchema).max(50),
});
export type JobCostBreakdown = z.infer<typeof JobCostBreakdownSchema>;
