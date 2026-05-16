import mongoose from 'mongoose';
import CostEvent from '../../models/CostEvent.js';
import type {
  JobCostSummary,
  JobCostBreakdown,
  CostCategory,
  CostEvent as CostEventType,
} from '../../../shared/index.js';
import { COST_CATEGORIES } from '../../../shared/index.js';

/**
 * Aggregator — reads CostEvent rows and rolls them up for the UI.
 *
 * Aggregation is cheap for normal job sizes (<1000 events). For
 * workspaces that have accumulated tens of thousands of events, the
 * date-range filters in `computeWorkspaceCost` keep index use tight
 * via `(workspaceId, occurredAt desc)`.
 *
 * JobCostSummary is also denormalized onto ProspectingJob.costSummary
 * at job completion so the hot-path job list / detail read doesn't need
 * the aggregator at all. The aggregator endpoint below is still the
 * authority — cached summary rebuilds on demand.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emptyByCategory(): Record<CostCategory, number> {
  const out = {} as Record<CostCategory, number>;
  for (const c of COST_CATEGORIES) out[c] = 0;
  return out;
}

export async function computeJobCostSummary(jobId: string): Promise<JobCostSummary> {
  const events = await CostEvent
    .find({ jobId: new mongoose.Types.ObjectId(jobId) })
    .select('category totalCostUSD')
    .lean();

  const byCategory = emptyByCategory();
  let totalUSD = 0;
  for (const e of events) {
    totalUSD += e.totalCostUSD ?? 0;
    if (e.category && e.category in byCategory) {
      byCategory[e.category as CostCategory] += e.totalCostUSD ?? 0;
    }
  }

  return {
    totalUSD: round2(totalUSD),
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, round2(v)]),
    ) as Record<CostCategory, number>,
    eventCount: events.length,
    computedAt: new Date().toISOString(),
  };
}

export async function computeJobCostBreakdown(jobId: string): Promise<JobCostBreakdown> {
  const events = await CostEvent
    .find({ jobId: new mongoose.Types.ObjectId(jobId) })
    .sort({ occurredAt: -1 })
    .lean();

  // Summary rollup
  const byCategory = emptyByCategory();
  let totalUSD = 0;
  for (const e of events) {
    totalUSD += e.totalCostUSD ?? 0;
    if (e.category in byCategory) {
      byCategory[e.category as CostCategory] += e.totalCostUSD ?? 0;
    }
  }

  // Per-provider rollup — groups by (category, provider, modelSlug)
  // so the UI can show "openrouter/anthropic/claude-sonnet-4-6: $0.18"
  // distinct from "openrouter/openai/gpt-4o-mini: $0.03".
  type Bucket = {
    category: CostCategory;
    provider: string;
    modelSlug?: string;
    totalUSD: number;
    eventCount: number;
    units: { input?: number; output?: number; cached?: number; count?: number; bytes?: number; seconds?: number };
  };
  const bucketMap = new Map<string, Bucket>();
  for (const e of events) {
    const k = `${e.category}|${e.provider}|${e.modelSlug ?? ''}`;
    const prev = bucketMap.get(k) ?? {
      category: e.category as CostCategory,
      provider: e.provider,
      ...(e.modelSlug ? { modelSlug: e.modelSlug } : {}),
      totalUSD: 0,
      eventCount: 0,
      units: {},
    };
    prev.totalUSD += e.totalCostUSD ?? 0;
    prev.eventCount += 1;
    for (const [uk, uv] of Object.entries(e.units ?? {})) {
      if (typeof uv === 'number') {
        prev.units[uk as keyof Bucket['units']] = (prev.units[uk as keyof Bucket['units']] ?? 0) + uv;
      }
    }
    bucketMap.set(k, prev);
  }
  const byProvider = [...bucketMap.values()]
    .sort((a, b) => b.totalUSD - a.totalUSD)
    .map((b) => ({ ...b, totalUSD: round2(b.totalUSD) }));

  // Cap recent events — full log ships via CSV export.
  const recentEvents = events.slice(0, 50).map(serializeEvent);

  return {
    jobId,
    summary: {
      totalUSD: round2(totalUSD),
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, round2(v)]),
      ) as Record<CostCategory, number>,
      eventCount: events.length,
      computedAt: new Date().toISOString(),
    },
    byProvider,
    recentEvents,
  };
}

export interface WorkspaceCostReport {
  range: { from: string; to: string };
  totalUSD: number;
  byCategory: Record<CostCategory, number>;
  byDay: Array<{ date: string; totalUSD: number }>;
  topJobs: Array<{ jobId: string; totalUSD: number; eventCount: number }>;
  eventCount: number;
}

/**
 * Rolls costs up for a workspace over a date window. Used by the
 * workspace-usage widget (rolling 30-day summary).
 */
export async function computeWorkspaceCost(params: {
  workspaceId: string;
  from: Date;
  to: Date;
}): Promise<WorkspaceCostReport> {
  const { workspaceId, from, to } = params;
  const workspaceObjId = new mongoose.Types.ObjectId(workspaceId);

  // Single aggregation — total, by-category, by-day, and top-10 jobs
  // in a single Mongo round trip via $facet. Cheap at the index shape
  // (workspaceId, occurredAt) we already have.
  const [facet] = await CostEvent.aggregate<{
    totals: Array<{ total: number; count: number }>;
    byCategory: Array<{ _id: CostCategory; total: number }>;
    byDay: Array<{ _id: string; total: number }>;
    byJob: Array<{ _id: mongoose.Types.ObjectId; total: number; count: number }>;
  }>([
    { $match: { workspaceId: workspaceObjId, occurredAt: { $gte: from, $lte: to } } },
    {
      $facet: {
        totals: [{ $group: { _id: null, total: { $sum: '$totalCostUSD' }, count: { $sum: 1 } } }],
        byCategory: [
          { $group: { _id: '$category', total: { $sum: '$totalCostUSD' } } },
        ],
        byDay: [
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } },
              total: { $sum: '$totalCostUSD' },
            },
          },
          { $sort: { _id: 1 } },
        ],
        byJob: [
          { $match: { jobId: { $exists: true } } },
          { $group: { _id: '$jobId', total: { $sum: '$totalCostUSD' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 10 },
        ],
      },
    },
  ]);

  const byCategory = emptyByCategory();
  for (const row of facet?.byCategory ?? []) {
    if (row._id in byCategory) byCategory[row._id] = round2(row.total);
  }

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totalUSD: round2(facet?.totals?.[0]?.total ?? 0),
    eventCount: facet?.totals?.[0]?.count ?? 0,
    byCategory,
    byDay: (facet?.byDay ?? []).map((d) => ({ date: d._id, totalUSD: round2(d.total) })),
    topJobs: (facet?.byJob ?? []).map((j) => ({
      jobId: String(j._id),
      totalUSD: round2(j.total),
      eventCount: j.count,
    })),
  };
}

/**
 * CSV serialization — one row per CostEvent. Streaming version would be
 * better for very large workspaces; v1 buffers since 180-day TTL caps
 * the size and v1 audiences are workspaces with <100k events.
 */
export async function exportWorkspaceCostCsv(params: {
  workspaceId: string;
  from: Date;
  to: Date;
}): Promise<string> {
  const { workspaceId, from, to } = params;
  const events = await CostEvent
    .find({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      occurredAt: { $gte: from, $lte: to },
    })
    .sort({ occurredAt: -1 })
    .lean();

  const header = [
    'occurredAt', 'category', 'provider', 'modelSlug',
    'totalCostUSD', 'jobId', 'campaignId',
    'units.input', 'units.output', 'units.cached',
    'units.count', 'units.bytes', 'units.seconds',
  ].join(',');

  const rows = events.map((e) => {
    const u = e.units ?? {};
    return [
      new Date(e.occurredAt).toISOString(),
      e.category,
      csvEscape(e.provider),
      csvEscape(e.modelSlug ?? ''),
      e.totalCostUSD ?? 0,
      e.jobId ? String(e.jobId) : '',
      e.campaignId ? String(e.campaignId) : '',
      u.input ?? '', u.output ?? '', u.cached ?? '',
      u.count ?? '', u.bytes ?? '', u.seconds ?? '',
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────

function round2(n: number): number {
  // Cost figures are shown to 2 decimals ("$0.42"). Store to 4 places
  // internally to avoid accumulating rounding errors across thousands
  // of events, then round at the API boundary for display.
  return Math.round(n * 10000) / 10000;
}

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function serializeEvent(e: Record<string, unknown>): CostEventType {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = e as any;
  return {
    _id: String(raw._id),
    workspaceId: String(raw.workspaceId),
    jobId: raw.jobId ? String(raw.jobId) : undefined,
    campaignId: raw.campaignId ? String(raw.campaignId) : undefined,
    category: raw.category,
    provider: raw.provider,
    modelSlug: raw.modelSlug,
    units: raw.units ?? {},
    unitPriceUSD: raw.unitPriceUSD,
    totalCostUSD: raw.totalCostUSD ?? 0,
    occurredAt: new Date(raw.occurredAt).toISOString(),
    meta: raw.meta,
  };
}
