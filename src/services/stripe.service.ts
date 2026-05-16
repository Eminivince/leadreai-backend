import Stripe from 'stripe';
import { env } from '../config/env.js';
import { CREDIT_PACKAGES, PLAN_CONFIG } from '../../shared/index.js';
import User from '../models/User.js';
import { grantCredits, subscribeToPlan, chargeCredits } from './credits.js';
import { processWebhookOnce } from './webhookIdempotency.js';
import { logger } from '../utils/logger.js';

function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' });
}

// Get or create a Stripe Customer for a user
export async function ensureStripeCustomer(userId: string, email: string): Promise<string> {
  const user = await User.findById(userId).select('stripeCustomerId');
  if (!user) throw new Error('User not found');
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create({ email, metadata: { userId } });
  await User.findByIdAndUpdate(userId, { stripeCustomerId: customer.id });
  return customer.id;
}

// Subscription checkout session (recurring)
export async function createStripeSubscribeSession(
  userId: string,
  email: string,
  planId: string,
): Promise<string> {
  if (!env.STRIPE_PRICE_ID_GROWTH) throw new Error('STRIPE_PRICE_ID_GROWTH not configured');
  if (planId !== 'growth') throw new Error('Only growth plan supports Stripe subscription');

  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(userId, email);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: env.STRIPE_PRICE_ID_GROWTH, quantity: 1 }],
    metadata: { userId, planId },
    success_url: `${env.FRONTEND_URL}/dashboard/settings/billing?stripe=subscribed`,
    cancel_url: `${env.FRONTEND_URL}/dashboard/settings/billing?stripe=cancelled`,
  });

  await User.findByIdAndUpdate(userId, { billingProvider: 'stripe' });
  return session.url!;
}

// One-time top-up checkout session
export async function createStripeTopUpSession(
  userId: string,
  email: string,
  packageId: string,
): Promise<string> {
  const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) throw new Error(`Unknown package: ${packageId}`);

  // Validate plan config is accessible (unused but ensures shared import works)
  void PLAN_CONFIG;

  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(userId, email);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(pkg.priceUsd * 100),
          product_data: {
            name: `${pkg.label} — LeadreAI credits`,
            description: pkg.tagline,
          },
        },
      },
    ],
    metadata: { userId, packageId, type: 'topup' },
    success_url: `${env.FRONTEND_URL}/dashboard/settings/billing?stripe=topped_up`,
    cancel_url: `${env.FRONTEND_URL}/dashboard/settings/billing?stripe=cancelled`,
  });

  await User.findByIdAndUpdate(userId, { billingProvider: 'stripe' });
  return session.url!;
}

// Webhook handler — call with req.rawBody and the stripe-signature header.
// Every event is processed at-most-once (see processWebhookOnce). Signature
// verification happens first so unauthenticated requests never reach the
// idempotency store.
export async function handleStripeWebhook(rawBody: Buffer, sig: string): Promise<void> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  const stripe = getStripe();

  const event = stripe.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);

  await processWebhookOnce(
    {
      provider: 'stripe',
      eventId: event.id,
      eventType: event.type,
      metadata: { livemode: event.livemode },
    },
    () => dispatchStripeEvent(event),
  );
}

async function dispatchStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      if (!userId) return;

      if (session.mode === 'subscription') {
        const planId = (session.metadata?.planId ?? 'growth') as 'free' | 'growth' | 'enterprise';
        await subscribeToPlan(userId, planId);
        if (session.subscription) {
          await User.findByIdAndUpdate(userId, {
            stripeSubscriptionId: String(session.subscription),
            billingProvider: 'stripe',
          });
        }
      } else if (session.mode === 'payment' && session.metadata?.type === 'topup') {
        const pkg = CREDIT_PACKAGES.find((p) => p.id === session.metadata?.packageId);
        if (pkg) {
          await grantCredits({
            userId,
            amount: pkg.credits,
            bucket: 'topup',
            reason: 'topup.stripe',
            description: `Stripe top-up — ${pkg.label}`,
            currency: 'usd',
            metadata: {
              packageId: pkg.id,
              priceUsd: pkg.priceUsd,
              sessionId: session.id,
              paymentIntentId: session.payment_intent,
            },
          });
        }
      }
      return;
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const user = await User.findOne({ stripeCustomerId: customerId }).select('_id plan');
      if (!user) return;
      await subscribeToPlan(String(user._id), user.plan as 'free' | 'growth' | 'enterprise');
      return;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (!customerId) return;
      const user = await User.findOne({ stripeCustomerId: customerId }).select('_id');
      if (user) await subscribeToPlan(String(user._id), 'free');
      return;
    }
    case 'charge.refunded':
    case 'charge.dispute.created': {
      // Reverse the credits we granted for the disputed/refunded charge.
      // Both events carry the original payment_intent in event.data.object.
      const obj = event.data.object as Stripe.Charge | Stripe.Dispute;
      const paymentIntentId = typeof obj.payment_intent === 'string'
        ? obj.payment_intent
        : obj.payment_intent?.id;
      if (!paymentIntentId) {
        logger.warn('[stripe] dispute/refund event missing payment_intent', { eventId: event.id });
        return;
      }
      // Lookup the original grant by sessionId or paymentIntentId in CreditTransaction metadata.
      const { default: CreditTransaction } = await import('../models/CreditTransaction.js');
      const grant = await CreditTransaction.findOne({
        kind: 'credit',
        'metadata.paymentIntentId': paymentIntentId,
      }).sort({ createdAt: -1 });
      if (!grant) {
        logger.warn('[stripe] no original grant found for reversal', { paymentIntentId, eventId: event.id });
        return;
      }
      // Best-effort reversal — clamp to current balance so we never throw.
      // Customers who already spent the credits before disputing get a
      // recorded liability but no negative balance.
      try {
        await chargeCredits({
          userId: grant.userId,
          amount: Math.abs(grant.delta),
          reason: event.type === 'charge.dispute.created' ? 'dispute.reversal' : 'refund.reversal',
          description: `Reversal for ${event.type} (${paymentIntentId})`,
          currency: 'usd',
          metadata: { paymentIntentId, originalTransactionId: String(grant._id), stripeEventId: event.id },
        });
      } catch (err) {
        // Don't fail the webhook — log and continue; manual reconciliation
        // is captured by the failed status on WebhookEvent if we throw, but
        // for an over-spent user the cleanest record is a stuck balance
        // with audit trail rather than a stuck webhook.
        logger.error('[stripe] reversal charge failed — manual reconciliation needed', {
          paymentIntentId, eventId: event.id, err: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    default:
      logger.debug('[stripe] ignoring event type', { type: event.type, id: event.id });
  }
}
