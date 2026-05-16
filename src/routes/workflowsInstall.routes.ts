import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import * as controller from '../controllers/workflows.controller.js';

/**
 * Public install surface for Phase 11 M2.
 *
 * Mounted at /api/v1/workflows/install/:shareToken.
 *
 *   GET  → public preview (redacts source workspaceId + createdBy).
 *   POST → authed; installs the workflow into req.user's chosen workspace.
 *
 * Lives outside the :workspaceId scope because the source workspace is
 * unknown at routing time — the share token IS the lookup key.
 */

const router: RouterType = Router();

router.get('/:shareToken', asyncHandler(controller.previewInstall));
router.post('/:shareToken', authenticate, asyncHandler(controller.installWorkflow));

export default router;
