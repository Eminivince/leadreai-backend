import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import User, { type IUser } from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import type { RegisterInput, LoginInput } from '../../shared/index.js';

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  path: '/api/v1/auth/refresh',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
  sameSite: 'strict' as const,
  secure: env.NODE_ENV === 'production',
};

function userPublicFields(user: IUser) {
  return {
    _id: user._id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    plan: user.plan,
    creditsBalance: user.creditsBalance,
  };
}

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password, firstName, lastName } = req.body as RegisterInput;

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

  let user: IUser | null = null;
  try {
    user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      plan: 'free' as const,
      creditsBalance: 0,
      isEmailVerified: false,
    });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: number }).code === 11000) {
      throw ApiError.conflict('Email already in use');
    }
    throw err;
  }

  try {
    const slug = `${firstName.toLowerCase()}-workspace-${randomBytes(4).toString('hex')}`;
    await Workspace.create({
      name: `${firstName}'s Workspace`,
      slug,
      ownerId: user._id,
      members: [{ userId: user._id, role: 'owner', joinedAt: new Date() }],
    });
  } catch (err) {
    // Workspace creation failed — remove the orphaned user to preserve atomicity
    await User.deleteOne({ _id: user._id });
    throw err;
  }

  const accessToken = signAccessToken({ sub: String(user._id), email: user.email, tv: user.tokenVersion });
  const refreshToken = signRefreshToken(String(user._id), user.tokenVersion);

  res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);
  logger.info('User registered', { userId: String(user._id), email: user.email });
  res.status(201).json({ success: true, data: { accessToken, user: userPublicFields(user) } });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginInput;

  // Select passwordHash explicitly since it has select:false
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');

  // Use a consistent error to avoid distinguishing user-not-found vs wrong-password
  const invalidCreds = ApiError.unauthorized('Invalid email or password');

  if (!user || !user.passwordHash) {
    throw invalidCreds;
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    logger.warn('Failed login attempt', { email });
    throw invalidCreds;
  }

  user.lastLoginAt = new Date();
  await user.save();

  const accessToken = signAccessToken({ sub: String(user._id), email: user.email, tv: user.tokenVersion });
  const refreshToken = signRefreshToken(String(user._id), user.tokenVersion);

  res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

  logger.info('User logged in', { userId: String(user._id), email: user.email });

  res.status(200).json({
    success: true,
    data: { accessToken, user: userPublicFields(user) },
  });
}

export async function logout(req: Request, res: Response): Promise<void> {
  // Server-side invalidation: bump tokenVersion so every token currently
  // in circulation (including any stolen refresh cookie) is rejected on
  // the next authenticate / refresh call. The cookie clear is incidental;
  // the real signal is in the database.
  if (req.user) {
    await User.findByIdAndUpdate(req.user._id, { $inc: { tokenVersion: 1 } }).catch((err) => {
      logger.warn('Failed to bump tokenVersion on logout', {
        userId: String(req.user?._id),
        err: err instanceof Error ? err.message : String(err),
      });
    });
    logger.info('User logged out', { userId: String(req.user._id) });
  }
  res.clearCookie('refresh_token', { path: '/api/v1/auth/refresh' });
  res.status(200).json({ success: true, data: null });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.refresh_token as string | undefined;
  if (!token) {
    throw ApiError.unauthorized('No refresh token provided');
  }

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const user = await User.findById(payload.sub);
  if (!user) {
    throw ApiError.unauthorized('User not found');
  }

  // Session-epoch check: a refresh cookie issued before the user logged
  // out (or was admin-revoked) carries a stale `tv`. Reject it so the
  // attacker can't exchange a stolen long-lived cookie for fresh access
  // tokens after the user has logically signed out.
  const refreshTv = payload.tv ?? 0;
  if (refreshTv !== user.tokenVersion) {
    logger.warn('Refresh rejected: tokenVersion mismatch', {
      userId: String(user._id),
      cookieTv: refreshTv,
      userTv: user.tokenVersion,
    });
    throw ApiError.unauthorized('Session expired');
  }

  const accessToken = signAccessToken({ sub: String(user._id), email: user.email, tv: user.tokenVersion });

  res.status(200).json({ success: true, data: { accessToken } });
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  res.status(200).json({ success: true, data: userPublicFields(req.user) });
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw ApiError.unauthorized();
  }

  const { firstName, lastName, avatarUrl } = req.body as {
    firstName?: string;
    lastName?: string;
    avatarUrl?: string;
  };

  // Only allow updating these specific fields
  const updates: Record<string, string> = {};
  if (firstName !== undefined) updates['firstName'] = firstName;
  if (lastName !== undefined) updates['lastName'] = lastName;
  if (avatarUrl !== undefined) updates['avatarUrl'] = avatarUrl;

  const updatedUser = await User.findByIdAndUpdate(
    req.user._id,
    { $set: updates },
    { new: true, runValidators: true }
  );

  if (!updatedUser) {
    throw ApiError.notFound('User not found');
  }

  res.status(200).json({ success: true, data: userPublicFields(updatedUser) });
}

export async function getCredits(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();

  // Lazy renewal: if the monthly bucket is due for a refill, bump it
  // before we return the balance so the user sees the true post-renewal
  // state rather than "last month's leftovers."
  const { renewSubscriptionIfDue } = await import('../services/credits.js');
  await renewSubscriptionIfDue(req.user._id).catch(() => {
    /* non-fatal — balance read below just sees pre-renewal state */
  });

  const user = await User.findById(req.user._id).select(
    'creditsBalance monthlyCreditsBalance subscriptionRenewsAt plan planExpiresAt',
  );
  if (!user) throw ApiError.notFound('User not found');

  res.json({
    success: true,
    data: {
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
      subscriptionRenewsAt: user.subscriptionRenewsAt,
      monthlyCreditsBalance: user.monthlyCreditsBalance,
      creditsBalance: user.creditsBalance,
      totalCreditsBalance: user.monthlyCreditsBalance + user.creditsBalance,
    },
  });
}

/* ── Onboarding wizard (Task #19) ────────────────────────────────── */

const ONBOARDING_STEPS = ['market', 'sender', 'knowledge', 'first-search'] as const;
type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export async function getOnboardingState(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id).select('onboardingState createdAt');
  if (!user) throw ApiError.notFound('User not found');
  const state = user.onboardingState ?? { completedSteps: [] };
  res.json({
    success: true,
    data: {
      steps: ONBOARDING_STEPS,
      completedSteps: state.completedSteps ?? [],
      dismissedAt: state.dismissedAt,
      completedAt: state.completedAt,
      // Hint for the frontend: hide the wizard unless the account was
      // created in the last 30 days. Avoids re-surfacing onboarding
      // for long-time users when the feature ships.
      isNewAccount: Date.now() - user.createdAt.getTime() < 30 * 24 * 3600 * 1000,
    },
  });
}

export async function completeOnboardingStep(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { step } = req.body as { step?: string };
  if (!step || !(ONBOARDING_STEPS as readonly string[]).includes(step)) {
    throw ApiError.badRequest(`step must be one of: ${ONBOARDING_STEPS.join(', ')}`);
  }
  const stepName = step as OnboardingStep;

  const updated = await User.findByIdAndUpdate(
    req.user._id,
    { $addToSet: { 'onboardingState.completedSteps': stepName } },
    { new: true, projection: { onboardingState: 1 } },
  );
  if (!updated) throw ApiError.notFound('User not found');

  // If every step is now done, stamp completedAt so the strip can hide
  // gracefully on the next render rather than waiting for the user to
  // dismiss it.
  const completed = updated.onboardingState?.completedSteps ?? [];
  if (
    completed.length === ONBOARDING_STEPS.length &&
    !updated.onboardingState?.completedAt
  ) {
    await User.updateOne(
      { _id: req.user._id },
      { $set: { 'onboardingState.completedAt': new Date() } },
    );
  }
  res.json({ success: true, data: updated.onboardingState });
}

export async function dismissOnboarding(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  await User.updateOne(
    { _id: req.user._id },
    { $set: { 'onboardingState.dismissedAt': new Date() } },
  );
  res.json({ success: true, data: { dismissed: true } });
}
