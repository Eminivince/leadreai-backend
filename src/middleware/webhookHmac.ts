import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export function webhookHmac(provider: 'resend' | 'sendgrid') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const secret = provider === 'resend' ? env.RESEND_WEBHOOK_SECRET : env.SENDGRID_WEBHOOK_SECRET;

    if (!secret) {
      // Webhook secret not configured — allow through (useful in development)
      next();
      return;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      next(ApiError.badRequest('Missing raw body for HMAC verification'));
      return;
    }

    // Resend uses svix-signature header; SendGrid uses x-twilio-email-event-webhook-signature
    const sigHeader = provider === 'resend'
      ? (req.headers['svix-signature'] as string | undefined)
      : (req.headers['x-twilio-email-event-webhook-signature'] as string | undefined);

    if (!sigHeader) {
      next(ApiError.unauthorized('Missing webhook signature header'));
      return;
    }

    // Extract raw signature bytes (strip "v1," prefix used by Svix)
    const sigValue = sigHeader.replace(/^v1,/, '').split(' ')[0] ?? '';

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    try {
      const expectedBuf = Buffer.from(expected, 'hex');
      const providedBuf = Buffer.from(sigValue, 'hex');
      if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
        next(ApiError.unauthorized('Invalid webhook signature'));
        return;
      }
    } catch {
      next(ApiError.unauthorized('Invalid webhook signature'));
      return;
    }

    next();
  };
}
