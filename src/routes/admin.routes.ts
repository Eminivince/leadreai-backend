import type { Router as ExpressRouter } from 'express';
import { Router } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import {
  getProspectingQueue,
  getEnrichmentQueue,
  getOutreachQueue,
  getExportQueue,
} from '../services/queue/queues.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as adminSupport from '../controllers/adminSupport.controller.js';

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullMQAdapter(getProspectingQueue()),
    new BullMQAdapter(getEnrichmentQueue()),
    new BullMQAdapter(getOutreachQueue()),
    new BullMQAdapter(getExportQueue()),
  ],
  serverAdapter,
});

const router: ExpressRouter = Router();
router.use(adminAuth);
router.use('/', serverAdapter.getRouter());

// Support-operator endpoints (Task #14). All gated by the same
// ADMIN_SECRET header check the BullBoard mount uses, so the surface
// is exactly the operators who already have the queue UI.
router.post('/support/users/:userId/credits', asyncHandler(adminSupport.adminAdjustCredits));
router.get('/support/jobs/:jobId', asyncHandler(adminSupport.adminInspectJob));
router.post('/support/users/:userId/impersonate', asyncHandler(adminSupport.adminImpersonate));

export default router;
