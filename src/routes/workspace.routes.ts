import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as workspaceController from '../controllers/workspace.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);

router.get('/', asyncHandler(workspaceController.listWorkspaces));
router.post('/', asyncHandler(workspaceController.createWorkspace));
// IDOR fix: GET requires workspace membership; DELETE requires owner role.
router.get('/:workspaceId', authorize(['owner', 'admin', 'member']), asyncHandler(workspaceController.getWorkspace));
router.patch('/:workspaceId', authorize(['owner', 'admin']), asyncHandler(workspaceController.updateWorkspace));
router.delete('/:workspaceId', authorize(['owner']), asyncHandler(workspaceController.deleteWorkspace));

// Agency-mode client sub-workspaces (Task #11). Owner/admin only.
router.get(
  '/:workspaceId/clients',
  authorize(['owner', 'admin']),
  asyncHandler(workspaceController.listClientWorkspaces),
);
router.post(
  '/:workspaceId/clients',
  authorize(['owner', 'admin']),
  asyncHandler(workspaceController.createClientWorkspace),
);

// SSO config (Task #20). Owner-only — these are security-relevant.
import * as ssoCtrl from '../controllers/sso.controller.js';
router.get(
  '/:workspaceId/sso',
  authorize(['owner']),
  asyncHandler(ssoCtrl.getSsoConfig),
);
router.put(
  '/:workspaceId/sso',
  authorize(['owner']),
  asyncHandler(ssoCtrl.updateSsoConfig),
);

router.get(
  '/:workspaceId/knowledge-base',
  authorize(['owner', 'admin']),
  asyncHandler(workspaceController.listKnowledgeBase)
);
router.post(
  '/:workspaceId/knowledge-base',
  authorize(['owner', 'admin']),
  asyncHandler(workspaceController.createKnowledgeBaseEntry)
);
router.patch(
  '/:workspaceId/knowledge-base/:entryId',
  authorize(['owner', 'admin']),
  asyncHandler(workspaceController.updateKnowledgeBaseEntry)
);
router.delete(
  '/:workspaceId/knowledge-base/:entryId',
  authorize(['owner', 'admin']),
  asyncHandler(workspaceController.deleteKnowledgeBaseEntry)
);

// Email config — owner-only (secrets stored here)
router.get(
  '/:workspaceId/email-config',
  authorize(['owner', 'admin']),
  asyncHandler(workspaceController.getEmailConfig)
);
router.put(
  '/:workspaceId/email-config',
  authorize(['owner']),
  asyncHandler(workspaceController.updateEmailConfig)
);
router.delete(
  '/:workspaceId/email-config',
  authorize(['owner']),
  asyncHandler(workspaceController.deleteEmailConfig)
);

// API key management — owner + admin can list, only owner can create/revoke
router.get(
  '/:workspaceId/api-keys',
  authorize(['owner', 'admin']),
  asyncHandler(workspaceController.listApiKeys)
);
router.post(
  '/:workspaceId/api-keys',
  authorize(['owner']),
  asyncHandler(workspaceController.createApiKey)
);
router.delete(
  '/:workspaceId/api-keys/:keyId',
  authorize(['owner']),
  asyncHandler(workspaceController.revokeApiKey)
);

export default router;
