import type { ParsedIntent } from '../../shared/index.js';

/**
 * Estimates how long a prospecting job will take, based on the parsed intent,
 * then returns a wall-clock budget with a substantial markup so jobs don't
 * get cut off mid-flow.
 *
 * Observed baselines (local LLM on consumer hardware, ~25-30s per agent step):
 *   - contact_lookup, 1 named entity:      ~90-120s end-to-end
 *   - named_entity_list, targetCount=10:   ~102s per lead (observed 614s / 6 leads)
 *   - demographic_filter:                  ~90-100s per lead (SERP → filter → scrape)
 *
 * The markup protects against LLM-response variance and long scrape pages.
 */
export interface WallClockEstimate {
  /** Raw expected duration before markup (ms). */
  expectedMs: number;
  /** Final budget the agent loop should enforce (ms). */
  budgetMs: number;
  /** Human-readable breakdown — useful for logging and admin visibility. */
  explanation: string;
}

const BASE_OVERHEAD_MS = 60_000;        // intent load, initial planning, SERP warmup
const MARKUP_FACTOR = 2.5;              // substantial buffer for LLM variance
const FLOOR_MS = 5 * 60_000;            // never less than 5 min
const CEILING_MS = 60 * 60_000;         // never more than 60 min (safety cap)

const PER_LEAD_MS: Record<NonNullable<ParsedIntent['queryType']>, number> = {
  contact_lookup:     120_000,   // deep scrape on one named company
  named_entity_list:  120_000,   // discovery + per-entity scrape
  demographic_filter: 100_000,   // SERP-driven, broader but shallower
};

export function estimateWallClockMs(intent: ParsedIntent): WallClockEstimate {
  const queryType = intent.queryType ?? 'demographic_filter';
  const targetCount = Math.max(1, intent.targetCount ?? 10);
  const perLeadMs = PER_LEAD_MS[queryType];

  const expectedMs = BASE_OVERHEAD_MS + perLeadMs * targetCount;
  const withMarkup = Math.round(expectedMs * MARKUP_FACTOR);
  const budgetMs = Math.max(FLOOR_MS, Math.min(CEILING_MS, withMarkup));

  const expectedMin = Math.round(expectedMs / 60_000 * 10) / 10;
  const budgetMin = Math.round(budgetMs / 60_000 * 10) / 10;
  const explanation = `queryType=${queryType} targetCount=${targetCount} perLead=${perLeadMs / 1000}s base=${BASE_OVERHEAD_MS / 1000}s → expected=${expectedMin}min × ${MARKUP_FACTOR}x markup → budget=${budgetMin}min (floor=${FLOOR_MS / 60_000}min, cap=${CEILING_MS / 60_000}min)`;

  return { expectedMs, budgetMs, explanation };
}
