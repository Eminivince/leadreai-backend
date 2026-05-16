import crypto from 'crypto';
import { env } from '../config/env.js';
import { CREDIT_PACKAGES, PLAN_CONFIG } from '../../shared/index.js';
import User from '../models/User.js';
import { grantCredits, subscribeToPlan, chargeCredits } from './credits.js';
import { processWebhookOnce } from './webhookIdempotency.js';
import { logger } from '../utils/logger.js';

const PAYSTACK_BASE = 'https://api.paystack.co';

function paystackHeaders(): Record<string, string> {
  if (!env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY not configured');
  return {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Convert USD price to Paystack amount (in lowest denomination: kobo for NGN, cents for USD)
function toPaystackAmount(priceUsd: number): number {
  if (env.PAYSTACK_CURRENCY === 'usd') return Math.round(priceUsd * 100);
  return Math.round(priceUsd * (env.PAYSTACK_NGN_RATE ?? 1600) * 100);
}

function paystackCurrency(): string {
  return (env.PAYSTACK_CURRENCY ?? 'ngn').toUpperCase();
}

async function paystackPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: 'POST',
    headers: paystackHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    status: boolean;
    data: Record<string, unknown>;
    message?: string;
  };
  if (!json.status) throw new Error(`Paystack error: ${json.message ?? 'unknown'}`);
  return json.data;
}

// Initialize a subscription payment via Paystack
export async function initializePaystackSubscription(
  userId: string,
  email: string,
  planId: string,
): Promise<string> {
  if (planId !== 'growth') throw new Error('Only growth plan supported');
  const plan = PLAN_CONFIG.find((p) => p.id === planId);
  if (!plan || plan.priceUsd === null) throw new Error('Plan not priceable');

  const body: Record<string, unknown> = {
    email,
    amount: toPaystackAmount(plan.priceUsd),
    currency: paystackCurrency(),
    callback_url: `${env.FRONTEND_URL}/dashboard/settings/billing?paystack=subscribed`,
    metadata: { userId, type: 'subscription', planId },
    channels: ['card', 'bank', 'ussd', 'bank_transfer'],
  };

  // Use a recurring plan code if configured
  if (env.PAYSTACK_PLAN_CODE_GROWTH) body['plan'] = env.PAYSTACK_PLAN_CODE_GROWTH;

  const data = await paystackPost('/transaction/initialize', body);
  await User.findByIdAndUpdate(userId, { billingProvider: 'paystack' });
  return data['authorization_url'] as string;
}

// Initialize a one-time top-up payment via Paystack
// Returns both the hosted URL (for redirect fallback) and the access_code/reference needed
// for the inline popup so the user never leaves the page.
export async function initializePaystackTopUp(
  userId: string,
  email: string,
  packageId: string,
): Promise<{ authorizationUrl: string; accessCode: string; reference: string }> {
  const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) throw new Error(`Unknown package: ${packageId}`);

  const data = await paystackPost('/transaction/initialize', {
    email,
    amount: toPaystackAmount(pkg.priceUsd),
    currency: paystackCurrency(),
    callback_url: `${env.FRONTEND_URL}/dashboard?paystack=topped_up`,
    metadata: { userId, type: 'topup', packageId },
    channels: ['card', 'bank', 'ussd', 'bank_transfer'],
  });

  await User.findByIdAndUpdate(userId, { billingProvider: 'paystack' });
  return {
    authorizationUrl: data['authorization_url'] as string,
    accessCode: data['access_code'] as string,
    reference: data['reference'] as string,
  };
}

// Verify a Paystack transaction by reference and grant credits if valid.
// Idempotent: skips grant if this reference was already processed.
export async function verifyAndGrantPaystackTopUp(
  userId: string,
  reference: string,
): Promise<{ credits: number; packageId: string } | null> {
  if (!env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY not configured');

  // Idempotency guard — skip if already processed
  const { default: CreditTransaction } = await import('../models/CreditTransaction.js');
  const existing = await CreditTransaction.findOne({ 'metadata.reference': reference });
  if (existing) return null; // already granted via webhook or prior verify call

  const res = await fetch(
    `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: paystackHeaders() },
  );
  const json = (await res.json()) as { status: boolean; data: Record<string, unknown>; message?: string };
  if (!json.status || json.data['status'] !== 'success') return null;

  const metadata = (json.data['metadata'] ?? {}) as Record<string, unknown>;
  if (metadata['userId'] !== userId) return null; // wrong user
  if (metadata['type'] !== 'topup') return null;

  const packageId = metadata['packageId'] as string;
  const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) return null;

  await grantCredits({
    userId,
    amount: pkg.credits,
    bucket: 'topup',
    reason: 'topup.paystack',
    description: `Paystack top-up — ${pkg.label}`,
    currency: paystackCurrency().toLowerCase(),
    metadata: { packageId: pkg.id, reference },
  });

  return { credits: pkg.credits, packageId };
}

interface PaystackEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Derive a stable per-delivery event ID from a Paystack webhook payload.
 *
 * Paystack does not include a top-level `id` field in webhook envelopes
 * the way Stripe does. The closest stable handle is `data.reference` for
 * charge / topup events and `data.invoice_code` for invoice events. We
 * combine the event type with the most specific identifier available so
 * (eventType, businessId) becomes the dedup key.
 */
function paystackEventId(event: PaystackEvent): string | null {
  const data = event.data ?? {};
  const id =
    (typeof data['id'] === 'number' || typeof data['id'] === 'string' ? String(data['id']) : undefined) ??
    (typeof data['reference'] === 'string' ? data['reference'] : undefined) ??
    (typeof data['invoice_code'] === 'string' ? data['invoice_code'] : undefined) ??
    (typeof data['subscription_code'] === 'string' ? data['subscription_code'] : undefined);
  if (!id) return null;
  return `${event.event}:${id}`;
}

// Webhook handler — verify HMAC-SHA512, dedup by (event, reference|id), dispatch.
export async function handlePaystackWebhook(rawBody: string, hash: string): Promise<void> {
  if (!env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY not configured');

  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  if (expected !== hash) throw new Error('Invalid Paystack signature');

  const event = JSON.parse(rawBody) as PaystackEvent;
  const eventId = paystackEventId(event);
  if (!eventId) {
    // Paystack didn't give us a stable handle — log and treat as
    // non-idempotent. Better to drop than to ack what we can't dedup.
    logger.warn('[paystack] webhook missing dedup key — ignoring', { event: event.event });
    return;
  }

  await processWebhookOnce(
    { provider: 'paystack', eventId, eventType: event.event },
    () => dispatchPaystackEvent(event),
  );
}

async function dispatchPaystackEvent(event: PaystackEvent): Promise<void> {
  const data = event.data;
  const currency = paystackCurrency().toLowerCase();

  switch (event.event) {
    case 'charge.success': {
      const metadata = (data['metadata'] ?? {}) as Record<string, unknown>;
      const userId = metadata['userId'] as string | undefined;
      if (!userId) return;

      if (metadata['type'] === 'subscription') {
        const planId = (metadata['planId'] ?? 'growth') as 'free' | 'growth' | 'enterprise';
        await subscribeToPlan(userId, planId);
        if (data['subscription_code']) {
          await User.findByIdAndUpdate(userId, {
            paystackCustomerCode:
              (data['customer'] as Record<string, unknown>)?.['customer_code'] as string,
            billingProvider: 'paystack',
          });
        }
      } else if (metadata['type'] === 'topup') {
        const pkg = CREDIT_PACKAGES.find((p) => p.id === (metadata['packageId'] as string));
        if (pkg) {
          await grantCredits({
            userId,
            amount: pkg.credits,
            bucket: 'topup',
            reason: 'topup.paystack',
            description: `Paystack top-up — ${pkg.label}`,
            currency,
            metadata: { packageId: pkg.id, reference: data['reference'] },
          });
        }
      }
      return;
    }
    case 'invoice.create':
    case 'invoice.update': {
      const customer = data['customer'] as Record<string, unknown> | undefined;
      const customerCode = customer?.['customer_code'] as string | undefined;
      if (!customerCode) return;
      const user = await User.findOne({ paystackCustomerCode: customerCode }).select('_id plan');
      if (user) await subscribeToPlan(String(user._id), user.plan as 'free' | 'growth' | 'enterprise');
      return;
    }
    case 'subscription.disable': {
      const customer = data['customer'] as Record<string, unknown> | undefined;
      const customerCode = customer?.['customer_code'] as string | undefined;
      if (!customerCode) return;
      const user = await User.findOne({ paystackCustomerCode: customerCode }).select('_id');
      if (user) await subscribeToPlan(String(user._id), 'free');
      return;
    }
    case 'refund.processed':
    case 'refund.pending':
    case 'charge.refund': {
      // Reverse credits granted from the original topup. Paystack carries
      // the original transaction reference in data.transaction.reference
      // (refund object) or data.reference (charge.refund variant).
      const txn = data['transaction'] as Record<string, unknown> | undefined;
      const reference =
        (txn?.['reference'] as string | undefined) ??
        (data['reference'] as string | undefined);
      if (!reference) {
        logger.warn('[paystack] refund event missing original reference', { event: event.event });
        return;
      }
      const { default: CreditTransaction } = await import('../models/CreditTransaction.js');
      const grant = await CreditTransaction.findOne({
        kind: 'credit',
        'metadata.reference': reference,
      }).sort({ createdAt: -1 });
      if (!grant) {
        logger.warn('[paystack] no original grant for refund', { reference });
        return;
      }
      try {
        await chargeCredits({
          userId: grant.userId,
          amount: Math.abs(grant.delta),
          reason: 'refund.reversal',
          description: `Paystack refund (${reference})`,
          currency,
          metadata: { reference, originalTransactionId: String(grant._id) },
        });
      } catch (err) {
        logger.error('[paystack] refund reversal failed — manual reconciliation needed', {
          reference, err: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    default:
      logger.debug('[paystack] ignoring event type', { type: event.event });
  }
}
