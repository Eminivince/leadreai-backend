import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as exportController from '../controllers/export.controller.js';

const router: RouterType = Router({ mergeParams: true });
router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.post('/leads', asyncHandler(exportController.exportLeads));

export default router;
