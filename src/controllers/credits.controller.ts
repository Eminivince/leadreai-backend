import type { Request, Response } from 'express';
import CreditTransaction from '../models/CreditTransaction.js';
import { grantCredits, subscribeToPlan } from '../services/credits.js';
import { ApiError } from '../utils/ApiError.js';
import { CREDIT_PACKAGES, PLAN_TIERS, type PlanTier } from '../../shared/index.js';

export async function listTransactions(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '30'), 10) || 30));

  const filter = { userId: req.user._id };
  const [rows, total] = await Promise.all([
    CreditTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CreditTransaction.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: {
      data: rows.map((t) => ({
        _id: String(t._id),
        userId: String(t.userId),
        workspaceId: t.workspaceId ? String(t.workspaceId) : undefined,
        kind: t.kind,
        reason: t.reason,
        bucket: t.bucket,
        delta: t.delta,
        balanceAfter: t.balanceAfter,
        description: t.description,
        metadata: t.metadata,
        createdAt: t.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
    },
  });
}

/**
 * Dev-only placeholder top-up. Adds to the top-up bucket (credits that
 * roll over forever). Real Stripe checkout will replace this but the
 * wallet targeting stays identical — top-ups never land in the monthly
 * bucket because the monthly bucket is reset on renewal.
 */
export async function testTopUp(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();

  const { packageId } = req.body as { packageId?: unknown };
  if (typeof packageId !== 'string' || !packageId.trim()) {
    throw ApiError.badRequest('packageId is required');
  }

  const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) throw ApiError.badRequest(`Unknown packageId: ${packageId}`);

  const result = await grantCredits({
    userId: req.user._id,
    amount: pkg.credits,
    bucket: 'topup',
    reason: 'topup.test',
    description: `Test top-up — ${pkg.label}`,
    metadata: { packageId: pkg.id, priceUsd: pkg.priceUsd },
  });

  res.json({
    success: true,
    data: {
      balanceAfter: result.balanceAfter,
      transactionId: result.transactionId,
      bucket: result.bucket,
      credited: pkg.credits,
    },
  });
}

/**
 * Dev-only placeholder subscribe. Switches the user to the target plan
 * and seeds their monthly allowance. Stripe subscription webhook will
 * replace this; the service underneath (`subscribeToPlan`) is the same.
 */
export async function testSubscribe(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();

  const { plan } = req.body as { plan?: unknown };
  if (typeof plan !== 'string' || !(PLAN_TIERS as readonly string[]).includes(plan)) {
    throw ApiError.badRequest(
      `plan must be one of: ${PLAN_TIERS.join(', ')}`,
    );
  }

  const result = await subscribeToPlan(req.user._id, plan as PlanTier);

  res.json({
    success: true,
    data: {
      plan,
      monthlyAfter: result.monthlyAfter,
      renewsAt: result.renewsAt.toISOString(),
    },
  });
}
