import { Router, type Router as RouterType } from 'express';
import multer from 'multer';
import { asyncHandler } from '../utils/asyncHandler.js';
import { webhookHmac } from '../middleware/webhookHmac.js';
import * as webhooksController from '../controllers/webhooks.controller.js';
import * as billing from '../controllers/billing.controller.js';

const router: RouterType = Router();

// SendGrid Inbound Parse posts multipart/form-data — emails arrive as
// form fields (`headers`, `subject`, `text`, `html`, `from`, `to`) plus
// any attachments as files. We don't store the attachments here (no
// `dest`); they're rejected on the spot. The 10 MB cap is below
// SendGrid's 30 MB outer envelope to keep memory bounded.
const inboundParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Webhook routes: public (HMAC-verified) — no authenticate middleware
router.post('/resend', webhookHmac('resend'), asyncHandler(webhooksController.handleResendWebhook));
router.post('/sendgrid', webhookHmac('sendgrid'), asyncHandler(webhooksController.handleSendGridWebhook));

// Inbound email routing — no HMAC (Resend inbound uses a different auth model).
// Restrict to known ESP IPs at the load-balancer/reverse-proxy level in production.
router.post('/inbound/resend', asyncHandler(webhooksController.handleResendInbound));
router.post('/inbound/sendgrid', inboundParser.any(), asyncHandler(webhooksController.handleSendGridInbound));

// Payment provider webhooks — signature-verified inside the handlers
router.post('/stripe', asyncHandler(billing.stripeWebhook));
router.post('/paystack', asyncHandler(billing.paystackWebhook));

export default router;
