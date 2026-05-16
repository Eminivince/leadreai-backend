import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as campaignsController from '../controllers/campaigns.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.get('/', asyncHandler(campaignsController.listCampaigns));
router.post('/', asyncHandler(campaignsController.createCampaign));
router.get('/:campaignId', asyncHandler(campaignsController.getCampaign));
router.patch('/:campaignId', asyncHandler(campaignsController.updateCampaign));
router.delete('/:campaignId', asyncHandler(campaignsController.deleteCampaign));

router.get('/:campaignId/leads', asyncHandler(campaignsController.listCampaignLeads));

router.get('/:campaignId/preflight', asyncHandler(campaignsController.preflightCampaign));
router.post('/:campaignId/activate', asyncHandler(campaignsController.activateCampaignHandler));

router.get('/:campaignId/stats', asyncHandler(campaignsController.campaignStats));
router.post('/:campaignId/pause', asyncHandler(campaignsController.pauseCampaignHandler));
router.post('/:campaignId/resume', asyncHandler(campaignsController.resumeCampaignHandler));
router.post('/:campaignId/archive', asyncHandler(campaignsController.archiveCampaignHandler));

export default router;
