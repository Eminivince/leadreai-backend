import { Router, type Router as ExpressRouter } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { gmailConnect, gmailStatus, gmailDisconnect } from '../controllers/gmail.controller.js';

const router: ExpressRouter = Router({ mergeParams: true });
router.use(authenticate);

// Gmail OAuth is workspace-scoped — connect / disconnect changes secrets.
// IDOR fix: gating to owner+admin so a member can't tamper with sender setup
// for another workspace they may have stumbled into.
router.get('/gmail/connect', authorize(['owner', 'admin']), asyncHandler(gmailConnect));
router.get('/gmail/status', authorize(['owner', 'admin', 'member']), asyncHandler(gmailStatus));
router.delete('/gmail/disconnect', authorize(['owner', 'admin']), asyncHandler(gmailDisconnect));

export default router;
