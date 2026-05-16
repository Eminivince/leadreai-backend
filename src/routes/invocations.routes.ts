import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as controller from '../controllers/dataSources.controller.js';

/**
 * Separate router for the invocation log — it's workspace-scoped, not
 * per-source. Mounted at /workspaces/:workspaceId/invocations.
 */

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.get('/', asyncHandler(controller.listInvocations));
router.get('/:invocationId', asyncHandler(controller.getInvocation));

export default router;
