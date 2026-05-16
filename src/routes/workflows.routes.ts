import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as controller from '../controllers/workflows.controller.js';

/**
 * Workflow routes (Phase 11 M1). Mounted at:
 *   /workspaces/:workspaceId/workflows                     — list + create
 *   /workspaces/:workspaceId/workflows/from-table/:tableId — snapshot from table
 *   /workspaces/:workspaceId/workflows/:workflowId         — read / update / delete
 *   /workspaces/:workspaceId/workflows/:workflowId/run     — execute
 */

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.get('/', asyncHandler(controller.listWorkflows));
router.post('/', asyncHandler(controller.createWorkflow));
router.post('/from-table/:tableId', asyncHandler(controller.createFromTable));
router.get('/:workflowId', asyncHandler(controller.getWorkflow));
router.patch('/:workflowId', asyncHandler(controller.updateWorkflow));
router.delete('/:workflowId', asyncHandler(controller.deleteWorkflow));
router.post('/:workflowId/run', asyncHandler(controller.runWorkflowHandler));

export default router;
