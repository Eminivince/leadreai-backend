import type { Request, Response } from 'express';
import { ApiError } from '../utils/ApiError.js';
import { PLAN_TIERS, CREDIT_PACKAGES } from '../../shared/index.js';
import {
  createStripeSubscribeSession,
  createStripeTopUpSession,
  handleStripeWebhook,
} from '../services/stripe.service.js';
import {
  initializePaystackSubscription,
  initializePaystackTopUp,
  handlePaystackWebhook,
  verifyAndGrantPaystackTopUp,
} from '../services/paystack.service.js';

// POST /api/v1/credits/stripe/subscribe
export async function stripeSubscribe(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { planId } = req.body as { planId?: string };
  if (!planId || !(PLAN_TIERS as readonly string[]).includes(planId)) {
    throw ApiError.badRequest('Invalid planId');
  }
  const url = await createStripeSubscribeSession(String(req.user._id), req.user.email, planId);
  res.json({ success: true, data: { url } });
}

// POST /api/v1/credits/stripe/topup
export async function stripeTopUp(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { packageId } = req.body as { packageId?: string };
  if (!packageId || !CREDIT_PACKAGES.find((p) => p.id === packageId)) {
    throw ApiError.badRequest('Invalid packageId');
  }
  const url = await createStripeTopUpSession(String(req.user._id), req.user.email, packageId);
  res.json({ success: true, data: { url } });
}

// POST /api/v1/credits/paystack/subscribe
export async function paystackSubscribe(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { planId } = req.body as { planId?: string };
  if (!planId || !(PLAN_TIERS as readonly string[]).includes(planId)) {
    throw ApiError.badRequest('Invalid planId');
  }
  const url = await initializePaystackSubscription(String(req.user._id), req.user.email, planId);
  res.json({ success: true, data: { url } });
}

// POST /api/v1/credits/paystack/topup
export async function paystackTopUp(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { packageId } = req.body as { packageId?: string };
  if (!packageId || !CREDIT_PACKAGES.find((p) => p.id === packageId)) {
    throw ApiError.badRequest('Invalid packageId');
  }
  const { authorizationUrl, accessCode, reference } = await initializePaystackTopUp(
    String(req.user._id),
    req.user.email,
    packageId,
  );
  res.json({ success: true, data: { url: authorizationUrl, accessCode, reference } });
}

// POST /api/v1/credits/paystack/verify
export async function paystackVerify(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { reference } = req.body as { reference?: string };
  if (!reference) throw ApiError.badRequest('reference is required');
  const result = await verifyAndGrantPaystackTopUp(String(req.user._id), reference);
  if (!result) {
    res.json({ success: true, data: { already_processed: true } });
    return;
  }
  res.json({ success: true, data: { credits: result.credits, packageId: result.packageId } });
}

// POST /api/v1/webhooks/stripe  (no auth — verified by signature)
export async function stripeWebhook(req: Request, res: Response): Promise<void> {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) throw ApiError.badRequest('Missing stripe-signature header');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawBody = (req as any).rawBody as Buffer;
  if (!rawBody) throw ApiError.badRequest('No raw body');
  await handleStripeWebhook(rawBody, sig);
  res.json({ received: true });
}

// POST /api/v1/webhooks/paystack  (no auth — verified by HMAC)
export async function paystackWebhook(req: Request, res: Response): Promise<void> {
  const hash = req.headers['x-paystack-signature'] as string;
  if (!hash) throw ApiError.badRequest('Missing x-paystack-signature');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawBody = (req as any).rawBody as Buffer;
  const bodyStr = rawBody ? rawBody.toString('utf8') : JSON.stringify(req.body);
  await handlePaystackWebhook(bodyStr, hash);
  res.status(200).json({ received: true });
}
