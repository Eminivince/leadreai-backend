import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import ProspectingJob from '../models/ProspectingJob.js';
import {
  computeJobCostBreakdown,
  computeWorkspaceCost,
  exportWorkspaceCostCsv,
} from '../services/cost/aggregator.js';
import { ApiError } from '../utils/ApiError.js';

// ── Per-job cost ─────────────────────────────────────────────────

export async function getJobCost(req: Request, res: Response): Promise<void> {
  const { workspaceId, jobId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(jobId!)) throw ApiError.badRequest('Invalid jobId');

  const job = await ProspectingJob
    .findOne({ _id: jobId, workspaceId })
    .select('_id status costSummary completedAt');
  if (!job) throw ApiError.notFound('Job not found');

  // Fresh breakdown — aggregator is cheap and lets us surface the full
  // by-provider rollup + recent events. The denormalized `costSummary`
  // on the job is a fast-path for listings; detail uses the aggregator.
  const breakdown = await computeJobCostBreakdown(String(job._id));

  // Opportunistically refresh the denormalized cache if stale.
  if (!job.costSummary || job.costSummary.eventCount !== breakdown.summary.eventCount) {
    await ProspectingJob.updateOne(
      { _id: job._id },
      { $set: { costSummary: breakdown.summary } },
    );
  }

  res.json({ success: true, data: breakdown });
}

// ── Workspace usage report ──────────────────────────────────────

export async function getWorkspaceUsage(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;

  const to = parseDate(req.query['to']) ?? new Date();
  const from = parseDate(req.query['from']) ?? new Date(to.getTime() - 30 * 24 * 3600_000);
  if (from > to) throw ApiError.badRequest('from must be <= to');

  const report = await computeWorkspaceCost({ workspaceId: workspaceId!, from, to });
  res.json({ success: true, data: report });
}

export async function exportWorkspaceUsage(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const to = parseDate(req.query['to']) ?? new Date();
  const from = parseDate(req.query['from']) ?? new Date(to.getTime() - 30 * 24 * 3600_000);
  if (from > to) throw ApiError.badRequest('from must be <= to');

  const csv = await exportWorkspaceCostCsv({ workspaceId: workspaceId!, from, to });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="usage-${workspaceId}-${isoDay(from)}-to-${isoDay(to)}.csv"`,
  );
  res.send(csv);
}

// ── Helpers ─────────────────────────────────────────────────────

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
