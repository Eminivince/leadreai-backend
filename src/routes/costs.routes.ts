import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as controller from '../controllers/costs.controller.js';

/**
 * Cost endpoints:
 *   /workspaces/:workspaceId/jobs/:jobId/cost    — per-job breakdown
 *   /workspaces/:workspaceId/usage               — workspace rolling report
 *   /workspaces/:workspaceId/usage/export        — CSV of raw CostEvents
 */

const jobRouter: RouterType = Router({ mergeParams: true });
jobRouter.use(authenticate);
jobRouter.use(authorize(['owner', 'admin', 'member']));
jobRouter.get('/:jobId/cost', asyncHandler(controller.getJobCost));

const usageRouter: RouterType = Router({ mergeParams: true });
usageRouter.use(authenticate);
usageRouter.use(authorize(['owner', 'admin', 'member']));
usageRouter.get('/', asyncHandler(controller.getWorkspaceUsage));
usageRouter.get('/export', asyncHandler(controller.exportWorkspaceUsage));

export { jobRouter as costsJobRouter, usageRouter as costsUsageRouter };
