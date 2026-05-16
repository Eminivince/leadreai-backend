import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import CostEvent from '../models/CostEvent.js';
import { emitNotification } from './notifications.js';
import { logger } from '../utils/logger.js';

/**
 * Cost budget alert checker (Task #15).
 *
 * Runs hourly. For each workspace with `budget.monthlyCapUSD` set:
 *   - Aggregates current calendar-month spend.
 *   - If spend ≥ alertThresholdPct of cap AND no alert fired this month,
 *     emits a `budget.threshold` notification and stamps `alertedAt`.
 *   - If a new month has started, clears `alertedAt` so the next
 *     threshold crossing fires again.
 *
 * Single read-modify-write per affected workspace per hour — light
 * enough to run inline in the Express process. No queue worker needed.
 */

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

async function monthToDateSpend(workspaceId: mongoose.Types.ObjectId, from: Date): Promise<number> {
  const [row] = await CostEvent.aggregate<{ total: number }>([
    { $match: { workspaceId, occurredAt: { $gte: from } } },
    { $group: { _id: null, total: { $sum: '$totalCostUSD' } } },
  ]);
  return row?.total ?? 0;
}

async function checkOne(ws: {
  _id: mongoose.Types.ObjectId;
  budget?: { monthlyCapUSD?: number; alertThresholdPct?: number; alertedAt?: Date };
}): Promise<void> {
  if (!ws.budget?.monthlyCapUSD || ws.budget.monthlyCapUSD <= 0) return;
  const thresholdPct = ws.budget.alertThresholdPct ?? 80;
  const cap = ws.budget.monthlyCapUSD;
  const threshold = (cap * thresholdPct) / 100;

  const now = new Date();
  const monthFrom = monthStart(now);

  // If alertedAt is in a prior month, clear it so this cycle's first
  // crossing fires fresh. Stamped on the workspace doc, not held in
  // memory — survives process restarts.
  if (ws.budget.alertedAt && ws.budget.alertedAt < monthFrom) {
    await Workspace.updateOne({ _id: ws._id }, { $unset: { 'budget.alertedAt': 1 } });
    ws.budget.alertedAt = undefined;
  }
  if (ws.budget.alertedAt) return; // already fired this month

  const spent = await monthToDateSpend(ws._id, monthFrom);
  if (spent < threshold) return;

  await emitNotification({
    workspaceId: ws._id,
    type: 'budget.threshold',
    title: `You've used ${Math.round((spent / cap) * 100)}% of this month's budget`,
    message: `$${spent.toFixed(2)} of your $${cap.toFixed(2)} monthly cap is spent.`,
    href: '/dashboard/settings/billing',
    metadata: { spentUSD: spent, capUSD: cap, thresholdPct },
  });
  await Workspace.updateOne(
    { _id: ws._id },
    { $set: { 'budget.alertedAt': new Date() } },
  ).catch((err: unknown) => {
    logger.warn('[budgetChecker] failed to stamp alertedAt', {
      workspaceId: String(ws._id),
      err: err instanceof Error ? err.message : String(err),
    });
  });

  logger.info('[budgetChecker] threshold notification emitted', {
    workspaceId: String(ws._id),
    spent, cap, thresholdPct,
  });
}

let _timer: NodeJS.Timeout | null = null;

export function startBudgetChecker(): void {
  if (_timer) return;
  logger.info('[budgetChecker] starting', { intervalMs: CHECK_INTERVAL_MS });
  const tick = async (): Promise<void> => {
    try {
      const workspaces = await Workspace.find({
        'budget.monthlyCapUSD': { $exists: true, $gt: 0 },
      }).select('_id budget').lean();
      for (const w of workspaces) {
        await checkOne(w).catch((err: unknown) => {
          logger.warn('[budgetChecker] check threw', {
            workspaceId: String(w._id),
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logger.error('[budgetChecker] tick fan-out failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
  void tick();
  _timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

export function stopBudgetChecker(): void {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
}
