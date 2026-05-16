import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import { RegisterSchema, LoginSchema } from '../../shared/index.js';
import * as authController from '../controllers/auth.controller.js';
import * as oauthController from '../controllers/oauth.controller.js';
import * as magicLinkController from '../controllers/magicLink.controller.js';

const router: RouterType = Router();

router.post('/register', authRateLimiter, validate(RegisterSchema), asyncHandler(authController.register));
router.post('/login', authRateLimiter, validate(LoginSchema), asyncHandler(authController.login));
router.post('/logout', authenticate, asyncHandler(authController.logout));
router.post('/refresh', asyncHandler(authController.refresh));
router.get('/me', authenticate, asyncHandler(authController.me));
router.get('/me/credits', authenticate, asyncHandler(authController.getCredits));
router.patch('/me', authenticate, asyncHandler(authController.updateMe));
router.get('/me/onboarding', authenticate, asyncHandler(authController.getOnboardingState));
router.post('/me/onboarding/complete-step', authenticate, asyncHandler(authController.completeOnboardingStep));
router.post('/me/onboarding/dismiss', authenticate, asyncHandler(authController.dismissOnboarding));

// SAML SSO (Task #20). Login + ACS are unauthenticated (the IdP is
// the auth source); config endpoints sit under /workspaces/:id/sso to
// inherit the membership check.
import * as ssoController from '../controllers/sso.controller.js';
router.get('/saml/discover', asyncHandler(ssoController.ssoDiscover));
router.get('/saml/:workspaceId/login', asyncHandler(ssoController.ssoLogin));
router.post('/saml/:workspaceId/acs', asyncHandler(ssoController.ssoAssertionConsumer));

// Social — Google
router.get('/google', asyncHandler(oauthController.startGoogleAuth));
router.get('/google/callback', asyncHandler(oauthController.googleCallback));

// Passwordless — magic link
router.post('/magic-link/request', authRateLimiter, asyncHandler(magicLinkController.requestLink));
router.post('/magic-link/verify', authRateLimiter, asyncHandler(magicLinkController.verifyLink));

export default router;
