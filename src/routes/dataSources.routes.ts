import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as controller from '../controllers/dataSources.controller.js';

/**
 * Data Source routes. Mounted at:
 *   /workspaces/:workspaceId/data-sources      — list + per-source details
 *   /workspaces/:workspaceId/data-sources/:dataSourceId/credentials  — per-source credentials
 *   /workspaces/:workspaceId/data-sources/:dataSourceId/invoke       — manual test invocation
 *   /workspaces/:workspaceId/data-sources/:dataSourceId/test         — credential probe
 */

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

// Registry
router.get('/', asyncHandler(controller.listSources));
router.get('/:dataSourceId', asyncHandler(controller.getSource));

// Credentials
router.get('/:dataSourceId/credentials', asyncHandler(controller.listCredentials));
router.post('/:dataSourceId/credentials', asyncHandler(controller.addCredential));
router.delete('/:dataSourceId/credentials/:credentialId', asyncHandler(controller.deleteCredential));

// Live test (does not persist)
router.post('/:dataSourceId/test', asyncHandler(controller.testNewCredential));

// Manual invocation (used by UI "Test run" and table-cell enrichment in 15D)
router.post('/:dataSourceId/invoke', asyncHandler(controller.invokeSource));

export default router;
