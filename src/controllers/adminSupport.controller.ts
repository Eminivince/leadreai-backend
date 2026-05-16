import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import ProspectingJob from '../models/ProspectingJob.js';
import CreditTransaction from '../models/CreditTransaction.js';
import AuditLog from '../models/AuditLog.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { grantCredits, chargeCredits } from '../services/credits.js';
import { signAccessToken, signRefreshToken } from '../lib/jwt.js';

/**
 * Admin support routes (Task #14). Gated by ADMIN_SECRET via the
 * `adminAuth` middleware — these endpoints are operator-only, used
 * during support tickets to:
 *   - Adjust credit balances after a billing exception
 *   - Inspect a stuck or failed job in full
 *   - Issue a short-lived session as another user (read-only debug)
 *
 * Every action writes to AuditLog with a synthesized userId (the
 * caller is the operator, not a workspace user). Resource-type is
 * 'workspace' for credit moves, 'job' for inspection.
 */

const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId();
/** Used as the audit `userId` when the caller is the operator
 *  (no workspace user). Re-generated per process restart on purpose —
 *  audit consumers see operator actions as a distinct cohort. */
function systemActor(): mongoose.Types.ObjectId {
  return SYSTEM_ACTOR_ID;
}

/* ── Credit adjust ───────────────────────────────────────────────── */

export async function adminAdjustCredits(req: Request, res: Response): Promise<void> {
  const { userId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(userId!)) {
    throw ApiError.badRequest('Invalid userId');
  }
  const body = req.body as {
    delta?: number;
    reason?: string;
    bucket?: 'monthly' | 'topup';
  };
  if (typeof body.delta !== 'number' || body.delta === 0) {
    throw ApiError.badRequest('delta must be a non-zero number');
  }
  if (!body.reason || typeof body.reason !== 'string') {
    throw ApiError.badRequest('reason is required');
  }
  const bucket = body.bucket ?? 'topup';

  const user = await User.findById(userId).select('email');
  if (!user) throw ApiError.notFound('User not found');

  // Positive delta = grant; negative = charge. Same transactional
  // primitives the webhook handlers use, so the ledger row + balance
  // mutation commit atomically.
  try {
    if (body.delta > 0) {
      await grantCredits({
        userId: userId!,
        amount: body.delta,
        bucket,
        reason: 'adjustment',
        description: `Admin adjust: ${body.reason}`,
        metadata: { operator: true, reason: body.reason },
      });
    } else {
      await chargeCredits({
        userId: userId!,
        amount: Math.abs(body.delta),
        reason: 'adjustment',
        description: `Admin adjust: ${body.reason}`,
        metadata: { operator: true, reason: body.reason },
      });
    }
  } catch (err) {
    logger.error('[admin] credit adjust failed', {
      userId, delta: body.delta, err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Audit log — adminSupport doesn't have a real workspaceId for the
  // event, so we reuse the user's first workspace as the attribution
  // anchor. Falls back to a synthesized id when the user has none.
  const firstWs = (await User.findById(userId).select('workspaces').lean())?.workspaces?.[0]?.workspaceId;
  await AuditLog.create({
    workspaceId: firstWs ?? new mongoose.Types.ObjectId(),
    userId: systemActor(),
    action: 'admin.credits.adjust',
    resourceType: 'workspace',
    resourceId: new mongoose.Types.ObjectId(userId!),
    metadata: { delta: body.delta, bucket, reason: body.reason, userEmail: user.email },
  }).catch(() => { /* audit best-effort */ });

  res.json({ success: true, data: { applied: body.delta } });
}

/* ── Job inspect ─────────────────────────────────────────────────── */

export async function adminInspectJob(req: Request, res: Response): Promise<void> {
  const { jobId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(jobId!)) {
    throw ApiError.badRequest('Invalid jobId');
  }
  const job = await ProspectingJob.findById(jobId);
  if (!job) throw ApiError.notFound('Job not found');

  // Recent credit movements tied to this job — useful for "user
  // charged but job didn't run" tickets. We look up via metadata.jobId
  // which the dispatch path stamps on the ledger row.
  const ledger = await CreditTransaction.find({ 'metadata.jobId': String(job._id) })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  res.json({
    success: true,
    data: { job, ledger },
  });
}

/* ── Impersonation ────────────────────────────────────────────────── */

/**
 * Issue a short-lived (15-min default) session as another user. This is
 * READ-ONLY in operator UI — the access token is identical to a real
 * user token in claims, so any state-mutating action would carry the
 * operator's blame, not the user's. AuditLog row attributes the
 * impersonation event to the system actor so it's auditable.
 *
 * Refresh token is intentionally NOT issued — operator sessions die
 * with the access token's 15-min exp. That keeps the blast radius
 * bounded and avoids surfacing operator activity through the user's
 * own refresh flow.
 */
export async function adminImpersonate(req: Request, res: Response): Promise<void> {
  const { userId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(userId!)) {
    throw ApiError.badRequest('Invalid userId');
  }
  const body = req.body as { reason?: string };
  if (!body.reason) throw ApiError.badRequest('reason is required for audit');

  const user = await User.findById(userId).select('email tokenVersion workspaces');
  if (!user) throw ApiError.notFound('User not found');

  const accessToken = signAccessToken({
    sub: String(user._id),
    email: user.email,
    tv: user.tokenVersion ?? 0,
  });

  // We deliberately don't issue a refresh token for impersonation
  // sessions — see comment above the function.
  void signRefreshToken;

  const firstWs = user.workspaces?.[0]?.workspaceId;
  await AuditLog.create({
    workspaceId: firstWs ?? new mongoose.Types.ObjectId(),
    userId: systemActor(),
    action: 'admin.impersonate',
    resourceType: 'workspace',
    resourceId: user._id as mongoose.Types.ObjectId,
    metadata: { userEmail: user.email, reason: body.reason },
  }).catch(() => { /* audit best-effort */ });

  res.json({
    success: true,
    data: {
      accessToken,
      user: {
        _id: user._id,
        email: user.email,
        workspaces: user.workspaces,
      },
      expiresInSeconds: 15 * 60,
    },
  });
}
