import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as outreachController from '../controllers/outreach.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

// Outreach drafts
router.post('/outreach/generate', asyncHandler(outreachController.generateSingleDraft));
router.get('/outreach', asyncHandler(outreachController.listDrafts));
router.get('/outreach/:draftId', asyncHandler(outreachController.getDraft));
router.patch('/outreach/:draftId', asyncHandler(outreachController.updateDraft));
router.post('/outreach/:draftId/approve', asyncHandler(outreachController.approveDraft));
router.post('/outreach/:draftId/send', asyncHandler(outreachController.sendDraft));
router.delete('/outreach/:draftId', asyncHandler(outreachController.deleteDraft));

// Campaign bulk generation + SSE stream
router.post('/campaigns/:campaignId/generate', asyncHandler(outreachController.generateCampaignDrafts));
// SSE route — NOT wrapped in asyncHandler, handles its own errors
router.get('/campaigns/:campaignId/generate/stream', outreachController.streamCampaignGeneration);

export default router;
