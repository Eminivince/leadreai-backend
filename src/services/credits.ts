import mongoose from 'mongoose';
import User from '../models/User.js';
import CreditTransaction, {
  type CreditTransactionReason,
} from '../models/CreditTransaction.js';
import type { CreditBucket, PlanTier } from '../../shared/index.js';
import { planConfig } from '../../shared/index.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

const MONTHLY_FIELD = 'monthlyCreditsBalance';
const TOPUP_FIELD = 'creditsBalance';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

interface LedgerNote {
  userId: string | mongoose.Types.ObjectId;
  workspaceId?: string | mongoose.Types.ObjectId;
  reason: CreditTransactionReason;
  description?: string;
  metadata?: Record<string, unknown>;
  // Optional currency tag — recorded so cross-provider reconciliation
  // (USD via Stripe + NGN via Paystack) can be audited. Falls back to USD
  // when omitted to preserve backward compatibility.
  currency?: string;
}

interface ChargeInput extends LedgerNote {
  amount: number;
}

interface GrantInput extends ChargeInput {
  bucket: CreditBucket;
}

interface LedgerEntry {
  transactionId: string;
  bucket: CreditBucket;
  delta: number;
  balanceAfter: number;
}

interface ChargeResult {
  totalAfter: number;
  monthlyAfter: number;
  topupAfter: number;
  entries: LedgerEntry[];
}

interface GrantResult {
  balanceAfter: number;
  transactionId: string;
  bucket: CreditBucket;
}

function fieldFor(bucket: CreditBucket): typeof MONTHLY_FIELD | typeof TOPUP_FIELD {
  return bucket === 'monthly' ? MONTHLY_FIELD : TOPUP_FIELD;
}

async function writeLedger(
  base: LedgerNote,
  bucket: CreditBucket,
  kind: 'debit' | 'credit',
  delta: number,
  balanceAfter: number,
  session?: mongoose.ClientSession,
): Promise<string> {
  // Ledger writes inside a transaction MUST NOT silently swallow failures —
  // the surrounding withTransaction() will roll back the balance change if
  // we throw. The legacy fire-and-forget catch is intentionally removed.
  const docs = await CreditTransaction.create(
    [{
      userId: base.userId,
      workspaceId: base.workspaceId,
      kind,
      reason: base.reason,
      bucket,
      delta,
      balanceAfter,
      description: base.description,
      metadata: { ...(base.metadata ?? {}), currency: base.currency ?? 'usd' },
    }],
    session ? { session } : undefined,
  );
  const doc = docs[0];
  if (!doc) throw new Error('[credits] ledger write returned empty result');
  return String(doc._id);
}

/**
 * Charge a user's combined credit balance.
 *
 * Invariants (CLAUDE.md high-risk protocol):
 *   - Combined balance can never go negative (enforced by $gte guards).
 *   - Every balance mutation has a matching CreditTransaction row (enforced
 *     by Mongoose transaction; if the ledger write fails the balance change
 *     rolls back).
 *   - A failed charge leaves zero side effects — no partial deduct, no
 *     orphan ledger rows.
 *
 * Consumption order: monthly first (subscription allowance — use it or
 * lose it), then top-up. A charge that spans both buckets emits two
 * ledger rows so the split is visible.
 */
export async function chargeCredits(input: ChargeInput): Promise<ChargeResult> {
  if (input.amount < 0) {
    throw new Error('chargeCredits amount must be non-negative');
  }

  if (input.amount === 0) {
    const user = await User.findById(input.userId).select(`${MONTHLY_FIELD} ${TOPUP_FIELD}`);
    if (!user) throw ApiError.notFound('User not found');
    return {
      totalAfter: user.monthlyCreditsBalance + user.creditsBalance,
      monthlyAfter: user.monthlyCreditsBalance,
      topupAfter: user.creditsBalance,
      entries: [],
    };
  }

  const session = await mongoose.startSession();
  try {
    let result: ChargeResult = { totalAfter: 0, monthlyAfter: 0, topupAfter: 0, entries: [] };
    await session.withTransaction(async () => {
      const user = await User.findById(input.userId)
        .select(`${MONTHLY_FIELD} ${TOPUP_FIELD}`)
        .session(session);
      if (!user) throw ApiError.notFound('User not found');

      const combined = user.monthlyCreditsBalance + user.creditsBalance;
      if (combined < input.amount) {
        throw ApiError.badRequest(
          `Insufficient credits. This action requires ${input.amount} credit${
            input.amount === 1 ? '' : 's'
          }. You have ${combined}.`,
        );
      }

      const fromMonthly = Math.min(input.amount, user.monthlyCreditsBalance);
      const fromTopup = input.amount - fromMonthly;
      const entries: LedgerEntry[] = [];

      let monthlyAfter = user.monthlyCreditsBalance;
      let topupAfter = user.creditsBalance;

      if (fromMonthly > 0) {
        const updated = await User.findOneAndUpdate(
          { _id: input.userId, [MONTHLY_FIELD]: { $gte: fromMonthly } },
          { $inc: { [MONTHLY_FIELD]: -fromMonthly } },
          { new: true, projection: { [MONTHLY_FIELD]: 1 }, session },
        );
        if (!updated) {
          throw ApiError.badRequest('Credit balance changed during charge; please retry.');
        }
        monthlyAfter = updated.monthlyCreditsBalance;
        const txnId = await writeLedger(input, 'monthly', 'debit', -fromMonthly, monthlyAfter, session);
        entries.push({ transactionId: txnId, bucket: 'monthly', delta: -fromMonthly, balanceAfter: monthlyAfter });
      }

      if (fromTopup > 0) {
        const updated = await User.findOneAndUpdate(
          { _id: input.userId, [TOPUP_FIELD]: { $gte: fromTopup } },
          { $inc: { [TOPUP_FIELD]: -fromTopup } },
          { new: true, projection: { [TOPUP_FIELD]: 1 }, session },
        );
        if (!updated) {
          // Transaction will roll back the monthly portion automatically;
          // no manual refund needed (the previous hand-rolled compensation
          // is now obsolete).
          throw ApiError.badRequest('Credit balance changed during charge; please retry.');
        }
        topupAfter = updated.creditsBalance;
        const txnId = await writeLedger(input, 'topup', 'debit', -fromTopup, topupAfter, session);
        entries.push({ transactionId: txnId, bucket: 'topup', delta: -fromTopup, balanceAfter: topupAfter });
      }

      result = { totalAfter: monthlyAfter + topupAfter, monthlyAfter, topupAfter, entries };
    });
    logger.info('[credits] charge succeeded', {
      userId: String(input.userId),
      reason: input.reason,
      amount: input.amount,
      totalAfter: result.totalAfter,
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Credit a specific bucket. Used for refunds, top-ups, and subscription
 * renewals. The caller decides which wallet to fund.
 *
 * Transactional: the User balance update and the matching CreditTransaction
 * row are written in a single Mongoose transaction. A ledger failure rolls
 * back the balance change so we never have credits added without a record,
 * or a record without a balance change.
 */
export async function grantCredits(input: GrantInput): Promise<GrantResult> {
  if (input.amount <= 0) {
    throw new Error('grantCredits amount must be positive');
  }

  const field = fieldFor(input.bucket);
  const session = await mongoose.startSession();
  try {
    let result: GrantResult = { balanceAfter: 0, transactionId: '', bucket: input.bucket };
    await session.withTransaction(async () => {
      const updated = await User.findByIdAndUpdate(
        input.userId,
        { $inc: { [field]: input.amount } },
        { new: true, projection: { [field]: 1 }, session },
      );
      if (!updated) throw ApiError.notFound('User not found');

      const balanceAfter =
        input.bucket === 'monthly' ? updated.monthlyCreditsBalance : updated.creditsBalance;
      const transactionId = await writeLedger(
        input,
        input.bucket,
        'credit',
        input.amount,
        balanceAfter,
        session,
      );
      result = { balanceAfter, transactionId, bucket: input.bucket };
    });
    logger.info('[credits] grant succeeded', {
      userId: String(input.userId),
      reason: input.reason,
      bucket: input.bucket,
      amount: input.amount,
      balanceAfter: result.balanceAfter,
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * If the user's subscription is due for renewal, top the monthly bucket
 * back up to `plan.monthlyCredits` and advance `subscriptionRenewsAt`.
 *
 * Important: unused monthly credits do NOT carry over. Renewal resets
 * the bucket to the allowance, regardless of remaining balance. This is
 * the "use it or lose it" rule; it's why the bucket is split from top-up
 * in the first place.
 *
 * Called lazily on credits reads and before charges — cheaper than a cron
 * for a small user base, and avoids a window where a renewal is "due"
 * but hasn't run yet.
 */
export async function renewSubscriptionIfDue(
  userId: string | mongoose.Types.ObjectId,
): Promise<{ renewed: boolean; monthlyAfter: number; renewsAt?: Date }> {
  const user = await User.findById(userId).select(
    'plan monthlyCreditsBalance subscriptionRenewsAt',
  );
  if (!user) throw ApiError.notFound('User not found');

  const now = new Date();
  const dueAt = user.subscriptionRenewsAt;

  if (dueAt && now < dueAt) {
    return { renewed: false, monthlyAfter: user.monthlyCreditsBalance, renewsAt: dueAt };
  }

  const plan = planConfig(user.plan as PlanTier);
  const next = new Date(now.getTime() + MONTH_MS);
  const seeding = !dueAt;

  const session = await mongoose.startSession();
  try {
    let monthlyAfter = user.monthlyCreditsBalance;
    let renewsAt: Date | undefined;
    await session.withTransaction(async () => {
      const update = seeding
        ? {
            $max: { monthlyCreditsBalance: plan.monthlyCredits },
            $set: { subscriptionRenewsAt: next },
          }
        : {
            // Renewal — reset bucket (use-it-or-lose-it), advance renewsAt.
            $set: { [MONTHLY_FIELD]: plan.monthlyCredits, subscriptionRenewsAt: next },
          };
      const updated = await User.findByIdAndUpdate(userId, update, {
        new: true,
        projection: { monthlyCreditsBalance: 1, subscriptionRenewsAt: 1 },
        session,
      });
      if (!updated) throw ApiError.notFound('User not found');
      monthlyAfter = updated.monthlyCreditsBalance;
      renewsAt = updated.subscriptionRenewsAt;

      if (plan.monthlyCredits > 0) {
        await writeLedger(
          {
            userId,
            reason: 'subscription.renewal',
            description: seeding
              ? `Seeded ${plan.label} allowance (${plan.monthlyCredits}/mo)`
              : `Monthly renewal — ${plan.label} (${plan.monthlyCredits}/mo)`,
          },
          'monthly',
          'credit',
          plan.monthlyCredits,
          updated.monthlyCreditsBalance,
          session,
        );
      }
    });
    return { renewed: true, monthlyAfter, renewsAt };
  } finally {
    await session.endSession();
  }
}

/**
 * Switch a user's plan, reset the monthly allowance to the new tier's
 * quota, and start a fresh 30-day renewal cycle. Used by the dev
 * subscribe endpoint today and by Stripe's webhook later.
 */
export async function subscribeToPlan(
  userId: string | mongoose.Types.ObjectId,
  plan: PlanTier,
): Promise<{ monthlyAfter: number; renewsAt: Date }> {
  const cfg = planConfig(plan);
  const now = new Date();
  const next = new Date(now.getTime() + MONTH_MS);

  const session = await mongoose.startSession();
  try {
    let monthlyAfter = 0;
    await session.withTransaction(async () => {
      const updated = await User.findByIdAndUpdate(
        userId,
        {
          $set: {
            plan,
            [MONTHLY_FIELD]: cfg.monthlyCredits,
            subscriptionRenewsAt: next,
            planExpiresAt: cfg.priceUsd === 0 ? undefined : next,
          },
        },
        { new: true, projection: { monthlyCreditsBalance: 1, subscriptionRenewsAt: 1 }, session },
      );
      if (!updated) throw ApiError.notFound('User not found');
      monthlyAfter = updated.monthlyCreditsBalance;

      if (cfg.monthlyCredits > 0) {
        await writeLedger(
          {
            userId,
            reason: 'subscription.change',
            description: `Subscribed to ${cfg.label} — ${cfg.monthlyCredits}/mo`,
            metadata: { plan, monthlyCredits: cfg.monthlyCredits },
          },
          'monthly',
          'credit',
          cfg.monthlyCredits,
          updated.monthlyCreditsBalance,
          session,
        );
      }
    });
    logger.info('[credits] plan change applied', { userId: String(userId), plan, monthlyAfter });
    return { monthlyAfter, renewsAt: next };
  } finally {
    await session.endSession();
  }
}
