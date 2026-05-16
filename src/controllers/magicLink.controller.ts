import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import User, { type IUser } from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { signAccessToken, signRefreshToken } from '../lib/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { requestMagicLink, verifyMagicLink } from '../services/magicLink.js';

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  path: '/api/v1/auth/refresh',
  maxAge: 30 * 24 * 60 * 60 * 1000,
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

function isValidEmail(s: string): boolean {
  // Deliberately loose — rely on Mongo unique index + the email
  // delivery attempt to catch bad addresses.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * POST /auth/magic-link/request  { email }
 *
 * Always returns 200 regardless of whether the email has an account.
 * Leaking that distinction would let an attacker enumerate users.
 * Throttling (per-email + global rate limiter) is the only thing that
 * shapes the response; success/failure cannot.
 */
export async function requestLink(req: Request, res: Response): Promise<void> {
  const body = req.body as { email?: unknown };
  if (typeof body.email !== 'string' || !isValidEmail(body.email)) {
    throw ApiError.badRequest('email is required');
  }

  const email = body.email.toLowerCase().trim();
  const result = await requestMagicLink({ email, ip: req.ip });

  // In dev mode we can return the link so the flow is testable without
  // a real email provider. Production never exposes this.
  const devUrl = env.NODE_ENV !== 'production' ? result.devUrl : undefined;

  res.json({
    success: true,
    data: {
      // Always reports "sent" to the client — throttled or actually-sent
      // look identical to the user. Server logs + telemetry keep the
      // internal distinction.
      status: 'sent',
      ...(devUrl ? { devUrl } : {}),
    },
  });
}

/**
 * POST /auth/magic-link/verify  { token }
 *
 * Consumes the token (atomic mark-used). Finds or creates the user
 * and (for new users) a starter workspace. Sets refresh cookie and
 * returns the access token + public user fields — same shape as the
 * password login endpoint.
 */
export async function verifyLink(req: Request, res: Response): Promise<void> {
  const body = req.body as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token.trim()) {
    throw ApiError.badRequest('token is required');
  }

  let email: string;
  try {
    const result = await verifyMagicLink(body.token.trim());
    email = result.email;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token';
    throw ApiError.unauthorized(message);
  }

  let user = await User.findOne({ email });
  const isNew = !user;

  if (!user) {
    // Derive a minimal firstName from the email local-part. Users can
    // fill in a proper byline in Settings → Account later. We don't
    // invent a lastName — the User model allows it to be absent.
    const localPart = email.split('@')[0] ?? 'Correspondent';
    const firstName = localPart.charAt(0).toUpperCase() + localPart.slice(1);

    try {
      user = await User.create({
        email,
        firstName,
        plan: 'free',
        isEmailVerified: true, // we just verified they own this inbox
      });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: number }).code === 11000) {
        // Race with another verify on a freshly-issued token.
        user = await User.findOne({ email });
      } else {
        throw err;
      }
    }

    if (user) {
      try {
        const slug = `${(user.firstName || 'desk').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-workspace-${randomBytes(
          4,
        ).toString('hex')}`;
        await Workspace.create({
          name: `${user.firstName}'s Workspace`,
          slug,
          ownerId: user._id,
          members: [{ userId: user._id, role: 'owner', joinedAt: new Date() }],
        });
      } catch (err) {
        logger.warn('[magicLink] workspace create failed (non-fatal)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!user) throw ApiError.unauthorized('User lookup failed');

  user.lastLoginAt = new Date();
  if (!user.isEmailVerified) user.isEmailVerified = true;
  await user.save();

  const accessToken = signAccessToken({ sub: String(user._id), email: user.email, tv: user.tokenVersion ?? 0 });
  const refreshToken = signRefreshToken(String(user._id), user.tokenVersion ?? 0);
  res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

  logger.info('[magicLink] authenticated', {
    userId: String(user._id),
    email: user.email,
    isNew,
  });

  res.json({
    success: true,
    data: {
      accessToken,
      user: userPublicFields(user),
      isNew,
    },
  });
}
