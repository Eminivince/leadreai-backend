import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as leadsController from '../controllers/leads.controller.js';

const router: RouterType = Router({ mergeParams: true });
router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.get('/', asyncHandler(leadsController.listLeads));
router.post('/bulk-tag', asyncHandler(leadsController.bulkTagLeads));
router.post('/bulk-delete', asyncHandler(leadsController.bulkDeleteLeads));
router.post('/bulk-suppress', asyncHandler(leadsController.bulkSuppressLeads));
router.get('/:leadId', asyncHandler(leadsController.getLead));
router.patch('/:leadId', asyncHandler(leadsController.updateLead));
router.delete('/:leadId', asyncHandler(leadsController.deleteLead));

export default router;
