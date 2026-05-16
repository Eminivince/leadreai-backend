import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import * as ctl from '../controllers/credits.controller.js';
import * as billing from '../controllers/billing.controller.js';

/**
 * Credits ledger + top-up. Routes are per-user (the credit balance
 * lives on User today). Mounted under /api/v1/credits.
 */
const router: RouterType = Router();

router.use(authenticate);

router.get('/transactions', asyncHandler(ctl.listTransactions));

// Dev stubs — keep for local testing without real payment keys
router.post('/test-topup', asyncHandler(ctl.testTopUp));
router.post('/test-subscribe', asyncHandler(ctl.testSubscribe));

// Stripe checkout routes
router.post('/stripe/subscribe', asyncHandler(billing.stripeSubscribe));
router.post('/stripe/topup', asyncHandler(billing.stripeTopUp));

// Paystack checkout routes
router.post('/paystack/subscribe', asyncHandler(billing.paystackSubscribe));
router.post('/paystack/topup', asyncHandler(billing.paystackTopUp));
router.post('/paystack/verify', asyncHandler(billing.paystackVerify));

export default router;
