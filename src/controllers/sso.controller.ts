import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { SAML } from '@node-saml/node-saml';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import { signAccessToken, signRefreshToken } from '../lib/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { logAudit } from '../services/audit.js';

/**
 * SAML 2.0 SP-initiated SSO (Task #20).
 *
 * Per-workspace IdP config — agency or enterprise customers point
 * their IdP (Okta, Auth0, Azure AD) at our ACS URL and we issue normal
 * LeadreAI sessions on successful assertion. NameID → user.email is
 * the mapping rule; we just-in-time provision when the asserted email
 * domain matches `workspace.ssoConfig.domain`.
 *
 * Gated behind `plan === 'enterprise'` on the config endpoints so a
 * Team-plan workspace can't silently enable SSO and bypass billing.
 */

function ssoCallbackUrl(workspaceId: string): string {
  return `${env.FRONTEND_URL.replace(/\/$/, '')}/api/v1/auth/saml/${workspaceId}/acs`;
}

/** Build a node-saml SAML instance from a workspace's stored config. */
async function buildSaml(workspaceId: string): Promise<SAML> {
  const workspace = await Workspace.findById(workspaceId).select(
    '+ssoConfig.cert ssoConfig',
  );
  if (!workspace?.ssoConfig?.enabled) {
    throw ApiError.badRequest('SSO is not enabled for this workspace');
  }
  const { entryPoint, issuer, cert } = workspace.ssoConfig;
  if (!entryPoint || !issuer || !cert) {
    throw ApiError.badRequest('SSO config is incomplete');
  }
  return new SAML({
    entryPoint,
    issuer,
    idpCert: cert,
    callbackUrl: ssoCallbackUrl(workspaceId),
    wantAssertionsSigned: true,
    disableRequestedAuthnContext: true,
  });
}

/* ── Discovery ──────────────────────────────────────────────────── */

/**
 * GET /api/v1/auth/saml/discover?email=user@acme.com
 * Returns `{ workspaceId, loginUrl }` for any workspace whose SSO is
 * enabled AND whose `domain` matches the email's domain. Used by the
 * login page's "Sign in with SSO" entry point so the user types an
 * email and we redirect to the correct IdP without exposing the
 * workspace list.
 */
export async function ssoDiscover(req: Request, res: Response): Promise<void> {
  const email = (req.query['email'] as string | undefined)?.toLowerCase();
  if (!email || !email.includes('@')) {
    throw ApiError.badRequest('email query parameter required');
  }
  const domain = email.split('@')[1];
  if (!domain) throw ApiError.badRequest('Invalid email');

  const workspace = await Workspace.findOne({
    'ssoConfig.enabled': true,
    'ssoConfig.domain': domain,
  }).select('_id');
  if (!workspace) {
    // Don't leak which domains have SSO configured to anonymous
    // callers. 404 with a generic message lets the SPA show
    // "no SSO configured for this email — use password sign-in".
    throw ApiError.notFound('No SSO configured for this email');
  }
  res.json({
    success: true,
    data: {
      workspaceId: String(workspace._id),
      loginUrl: `/api/v1/auth/saml/${String(workspace._id)}/login`,
    },
  });
}

/* ── Initiate ────────────────────────────────────────────────────── */

/**
 * GET /api/v1/auth/saml/:workspaceId/login
 * Unauthenticated. Redirects the browser to the IdP entry point with a
 * SAML AuthnRequest. The IdP posts back to /acs.
 */
export async function ssoLogin(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) {
    throw ApiError.badRequest('Invalid workspaceId');
  }
  const saml = await buildSaml(workspaceId!);
  const url = await saml.getAuthorizeUrlAsync('', undefined, {});
  res.redirect(url);
}

/* ── ACS — assertion consumer ────────────────────────────────────── */

/**
 * POST /api/v1/auth/saml/:workspaceId/acs
 * The IdP delivers the signed assertion here. We validate, extract
 * the NameID, just-in-time provision when domain matches, and issue
 * a normal LeadreAI session (httpOnly refresh cookie + access token).
 */
export async function ssoAssertionConsumer(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) {
    throw ApiError.badRequest('Invalid workspaceId');
  }

  const workspace = await Workspace.findById(workspaceId).select('+ssoConfig.cert ssoConfig ownerId name');
  if (!workspace?.ssoConfig?.enabled) {
    throw ApiError.badRequest('SSO is not enabled for this workspace');
  }
  // Plan check via the workspace's owner — plan lives on User in this
  // schema. Enterprise SKU is the gate.
  const owner = await User.findById(workspace.ownerId).select('plan');
  if (owner?.plan !== 'enterprise') {
    throw ApiError.forbidden('SSO requires the enterprise plan');
  }

  const saml = await buildSaml(workspaceId!);
  let profile: { nameID?: string; email?: string; [k: string]: unknown };
  try {
    const result = await saml.validatePostResponseAsync(req.body as Record<string, string>);
    profile = (result.profile ?? {}) as typeof profile;
  } catch (err) {
    logger.warn('[sso] SAML response invalid', {
      workspaceId, err: err instanceof Error ? err.message : String(err),
    });
    throw ApiError.unauthorized('Invalid SAML assertion');
  }

  const email = (profile.email as string | undefined) ?? profile.nameID;
  if (!email) {
    throw ApiError.unauthorized('SAML assertion did not carry an email / NameID');
  }
  const lower = email.toLowerCase();
  // Domain-allowlist check — keeps a misconfigured IdP from minting
  // sessions for arbitrary external accounts on this workspace.
  if (workspace.ssoConfig.domain) {
    const expected = workspace.ssoConfig.domain.toLowerCase();
    if (!lower.endsWith(`@${expected}`)) {
      throw ApiError.forbidden(`SSO assertion email must end with @${expected}`);
    }
  }

  // Just-in-time provision. We treat a SAML-asserted user as
  // email-verified — the IdP is the source of truth.
  let user = await User.findOne({ email: lower });
  if (!user) {
    user = await User.create({
      email: lower,
      firstName: lower.split('@')[0] ?? 'User',
      isEmailVerified: true,
      plan: 'free',
    });
    await Workspace.updateOne(
      { _id: workspaceId },
      { $push: { members: { userId: user._id, role: 'member', joinedAt: new Date() } } },
    );
  }

  const accessToken = signAccessToken({
    sub: String(user._id),
    email: user.email,
    tv: user.tokenVersion ?? 0,
  });
  const refreshToken = signRefreshToken(String(user._id), user.tokenVersion ?? 0);

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    path: '/api/v1/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
  });

  // The SAML POST originates from the IdP, not the SPA — we can't
  // return a JSON body the SPA will see. Redirect with the access
  // token in a fragment so JS in the landing page can pick it up
  // without it ending up in server logs.
  const target = `${env.FRONTEND_URL.replace(/\/$/, '')}/auth/sso/complete#token=${encodeURIComponent(accessToken)}`;
  res.redirect(target);
}

/* ── Config (enterprise only) ────────────────────────────────────── */

export async function getSsoConfig(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const workspace = await Workspace.findById(workspaceId).select('ssoConfig ownerId');
  if (!workspace) throw ApiError.notFound('Workspace not found');
  const owner = await User.findById(workspace.ownerId).select('plan');
  if (owner?.plan !== 'enterprise') {
    throw ApiError.forbidden('SSO requires the enterprise plan');
  }
  res.json({
    success: true,
    data: {
      enabled: workspace.ssoConfig?.enabled ?? false,
      entryPoint: workspace.ssoConfig?.entryPoint,
      issuer: workspace.ssoConfig?.issuer,
      // Cert is select:false — never returned. UI shows last-4 for confirmation.
      certPreview: undefined,
      domain: workspace.ssoConfig?.domain,
      acsUrl: ssoCallbackUrl(workspaceId!),
    },
  });
}

export async function updateSsoConfig(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const workspace = await Workspace.findById(workspaceId).select('ownerId');
  if (!workspace) throw ApiError.notFound('Workspace not found');
  const owner = await User.findById(workspace.ownerId).select('plan');
  if (owner?.plan !== 'enterprise') {
    throw ApiError.forbidden('SSO requires the enterprise plan');
  }
  const body = req.body as {
    enabled?: boolean;
    entryPoint?: string;
    issuer?: string;
    cert?: string;
    domain?: string;
  };
  const setFields: Record<string, unknown> = {};
  if (body.enabled !== undefined) setFields['ssoConfig.enabled'] = body.enabled;
  if (body.entryPoint !== undefined) setFields['ssoConfig.entryPoint'] = body.entryPoint;
  if (body.issuer !== undefined) setFields['ssoConfig.issuer'] = body.issuer;
  if (body.cert !== undefined) setFields['ssoConfig.cert'] = body.cert;
  if (body.domain !== undefined) setFields['ssoConfig.domain'] = body.domain;

  await Workspace.updateOne({ _id: workspaceId }, { $set: setFields });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'sso.config.update',
    resourceType: 'workspace',
    resourceId: workspaceId!,
    metadata: { enabled: body.enabled, hasCert: Boolean(body.cert) },
  });

  res.json({ success: true });
}
