import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import User, { type IUser } from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { signRefreshToken } from '../lib/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

/* ─────────────────────────────────────────────────────────────────
 * Google OAuth (Authorization Code flow).
 *
 *   GET  /auth/google           → redirect to Google consent
 *   GET  /auth/google/callback  → exchange code, upsert user, set
 *                                 refresh cookie, redirect to
 *                                 /auth/oauth/complete on frontend.
 *
 * We reuse the existing refresh-cookie session model. The frontend
 * completion page calls /auth/refresh + /auth/me to bootstrap its
 * in-memory access token, so no new cookie type is needed.
 *
 * CSRF: a short-lived httpOnly `oauth_state` cookie carries a random
 * nonce that must match the `state` param Google sends back.
 * ───────────────────────────────────────────────────────────────── */

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  path: '/api/v1/auth/refresh',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
};

const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  path: '/api/v1/auth/google/callback',
  maxAge: 10 * 60 * 1000, // 10 minutes — consent screen window
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
};

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_SCOPES = ['openid', 'email', 'profile'].join(' ');

function oauthConfigured(): boolean {
  return !!(
    env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET &&
    env.GOOGLE_OAUTH_REDIRECT_URI
  );
}

function safeReturnTo(input: unknown): string {
  // Only allow same-origin app paths. Anything that looks like a URL
  // with a scheme, or that starts with `//`, is rejected — an attacker
  // who can set `returnTo` otherwise could redirect post-login to any
  // phishing domain that shares the logged-in session cookie.
  if (typeof input !== 'string' || !input) return '/dashboard';
  if (!input.startsWith('/') || input.startsWith('//')) return '/dashboard';
  return input;
}

function frontendUrl(path: string): string {
  return `${env.FRONTEND_URL.replace(/\/$/, '')}${path}`;
}

export async function startGoogleAuth(req: Request, res: Response): Promise<void> {
  if (!oauthConfigured()) {
    throw ApiError.badRequest(
      'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.',
    );
  }

  const returnTo = safeReturnTo(req.query['returnTo']);
  const nonce = randomBytes(24).toString('base64url');
  const statePayload = Buffer.from(JSON.stringify({ nonce, returnTo })).toString('base64url');

  res.cookie('oauth_state', nonce, STATE_COOKIE_OPTIONS);

  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set('redirect_uri', env.GOOGLE_OAUTH_REDIRECT_URI!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES);
  url.searchParams.set('state', statePayload);
  url.searchParams.set('access_type', 'offline'); // not used today, but future-proof
  url.searchParams.set('prompt', 'select_account');

  res.redirect(url.toString());
}

interface GoogleTokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export async function googleCallback(req: Request, res: Response): Promise<void> {
  if (!oauthConfigured()) {
    throw ApiError.badRequest('Google OAuth is not configured.');
  }

  const code = typeof req.query['code'] === 'string' ? req.query['code'] : undefined;
  const stateRaw = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
  const errorParam = typeof req.query['error'] === 'string' ? req.query['error'] : undefined;

  if (errorParam) {
    res.redirect(frontendUrl(`/login?error=${encodeURIComponent(errorParam)}`));
    return;
  }
  if (!code || !stateRaw) {
    res.redirect(frontendUrl('/login?error=missing_code'));
    return;
  }

  // Validate state against the cookie we set in startGoogleAuth.
  const cookieNonce = req.cookies?.oauth_state as string | undefined;
  let returnTo = '/dashboard';
  try {
    const decoded = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8')) as {
      nonce?: string;
      returnTo?: string;
    };
    if (!cookieNonce || cookieNonce !== decoded.nonce) {
      throw new Error('state mismatch');
    }
    returnTo = safeReturnTo(decoded.returnTo);
  } catch {
    res.clearCookie('oauth_state', { path: '/api/v1/auth/google/callback' });
    res.redirect(frontendUrl('/login?error=state_mismatch'));
    return;
  }

  res.clearCookie('oauth_state', { path: '/api/v1/auth/google/callback' });

  // Exchange code for tokens.
  let tokenJson: GoogleTokenResponse;
  try {
    const body = new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
      grant_type: 'authorization_code',
    });
    const raw = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    tokenJson = (await raw.json()) as GoogleTokenResponse;
    if (!raw.ok || !tokenJson.access_token) {
      logger.warn('[oauth/google] token exchange failed', {
        status: raw.status,
        err: tokenJson.error,
      });
      res.redirect(frontendUrl('/login?error=token_exchange_failed'));
      return;
    }
  } catch (err) {
    logger.warn('[oauth/google] token exchange threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    res.redirect(frontendUrl('/login?error=token_exchange_failed'));
    return;
  }

  // Fetch user info.
  let info: GoogleUserInfo;
  try {
    const raw = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!raw.ok) {
      logger.warn('[oauth/google] userinfo failed', { status: raw.status });
      res.redirect(frontendUrl('/login?error=userinfo_failed'));
      return;
    }
    info = (await raw.json()) as GoogleUserInfo;
  } catch (err) {
    logger.warn('[oauth/google] userinfo threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    res.redirect(frontendUrl('/login?error=userinfo_failed'));
    return;
  }

  if (!info.email) {
    res.redirect(frontendUrl('/login?error=missing_email'));
    return;
  }

  const email = info.email.toLowerCase();
  const firstName = info.given_name?.trim() || info.name?.split(' ')[0] || 'Correspondent';
  // Use undefined (not '') so Mongoose doesn't reject at validation —
  // the model now treats lastName as optional.
  const lastNameRaw =
    info.family_name?.trim() || info.name?.split(' ').slice(1).join(' ').trim();
  const lastName = lastNameRaw && lastNameRaw.length > 0 ? lastNameRaw : undefined;

  // Find-or-create. Two lookup paths:
  //   1. Existing user by matching provider id (the common case on return).
  //   2. Existing user by email (first Google sign-in for an account that
  //      was originally created with a password) — auto-link the provider.
  // Else: create a new user + workspace.
  let user: IUser | null = await User.findOne({
    'providers.provider': 'google',
    'providers.providerId': info.sub,
  });

  if (!user) {
    user = await User.findOne({ email });
    if (user) {
      // Attach the provider row so subsequent logins hit the first query.
      user.providers = [
        ...(user.providers ?? []),
        { provider: 'google', providerId: info.sub, email, connectedAt: new Date() },
      ];
      if (info.picture && !user.avatarUrl) user.avatarUrl = info.picture;
      if (info.email_verified) user.isEmailVerified = true;
      user.lastLoginAt = new Date();
      await user.save();
    }
  }

  if (!user) {
    try {
      user = await User.create({
        email,
        firstName,
        lastName,
        avatarUrl: info.picture,
        plan: 'free',
        isEmailVerified: !!info.email_verified,
        providers: [
          {
            provider: 'google',
            providerId: info.sub,
            email,
            connectedAt: new Date(),
          },
        ],
        lastLoginAt: new Date(),
      });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: number }).code === 11000) {
        // Race: another request created the user between our lookups and
        // this insert. Re-fetch and move on.
        user = await User.findOne({ email });
      } else {
        logger.error('[oauth/google] user create failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        res.redirect(frontendUrl('/login?error=user_create_failed'));
        return;
      }
    }

    if (user) {
      try {
        const slug = `${firstName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'desk'}-workspace-${randomBytes(
          4,
        ).toString('hex')}`;
        await Workspace.create({
          name: `${firstName}'s Workspace`,
          slug,
          ownerId: user._id,
          members: [{ userId: user._id, role: 'owner', joinedAt: new Date() }],
        });
      } catch (err) {
        logger.warn('[oauth/google] workspace create failed (non-fatal)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    user.lastLoginAt = new Date();
    if (info.picture && !user.avatarUrl) user.avatarUrl = info.picture;
    await user.save();
  }

  if (!user) {
    res.redirect(frontendUrl('/login?error=no_user'));
    return;
  }

  const refreshToken = signRefreshToken(String(user._id), user.tokenVersion ?? 0);
  res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

  logger.info('[oauth/google] authenticated', {
    userId: String(user._id),
    email: user.email,
  });

  res.redirect(
    frontendUrl(`/auth/oauth/complete?returnTo=${encodeURIComponent(returnTo)}`),
  );
}
