import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as crmController from '../controllers/crm.controller.js';

// Routes mounted at /api/v1/workspaces/:workspaceId/crm
const router: RouterType = Router({ mergeParams: true });

// Authenticated routes
router.use(authenticate);

// GET  /hubspot/connect        → redirect to HubSpot OAuth (owner only)
router.get('/hubspot/connect', authorize(['owner']), asyncHandler(crmController.hubspotConnect));

// GET  /hubspot/status         → CRM connection status (admin+)
router.get('/hubspot/status', authorize(['owner', 'admin']), asyncHandler(crmController.hubspotStatus));

// DELETE /hubspot/disconnect   → revoke (owner only)
router.delete('/hubspot/disconnect', authorize(['owner']), asyncHandler(crmController.hubspotDisconnect));

// POST /hubspot/sync           → trigger full sync (admin+)
router.post('/hubspot/sync', authorize(['owner', 'admin']), asyncHandler(crmController.triggerHubspotSync));

// GET  /hubspot/sync-log       → view sync log (admin+)
router.get('/hubspot/sync-log', authorize(['owner', 'admin']), asyncHandler(crmController.getSyncLog));

export default router;

// Separate router for /leads/:leadId/crm-push
// Mount at /api/v1/workspaces/:workspaceId/leads
export const crmLeadsRouter: RouterType = Router({ mergeParams: true });
crmLeadsRouter.use(authenticate);
crmLeadsRouter.post(
  '/:leadId/crm-push',
  authorize(['owner', 'admin']),
  asyncHandler(crmController.pushLeadToCrm)
);
