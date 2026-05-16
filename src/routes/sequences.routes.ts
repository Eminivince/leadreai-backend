import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as sequencesController from '../controllers/sequences.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);

router.get('/', authorize(['owner', 'admin', 'member']), asyncHandler(sequencesController.listSequences));
router.post('/', authorize(['owner', 'admin']), asyncHandler(sequencesController.createSequence));
router.get('/:sequenceId', authorize(['owner', 'admin', 'member']), asyncHandler(sequencesController.getSequence));
router.patch('/:sequenceId', authorize(['owner', 'admin']), asyncHandler(sequencesController.updateSequence));
router.delete('/:sequenceId', authorize(['owner', 'admin']), asyncHandler(sequencesController.archiveSequence));
router.post('/:sequenceId/enroll', authorize(['owner', 'admin', 'member']), asyncHandler(sequencesController.enrollLeads));
router.post('/:sequenceId/pause', authorize(['owner', 'admin']), asyncHandler(sequencesController.pauseSequence));
router.post('/:sequenceId/resume', authorize(['owner', 'admin']), asyncHandler(sequencesController.resumeSequence));
router.get('/:sequenceId/stats', authorize(['owner', 'admin', 'member']), asyncHandler(sequencesController.getSequenceStats));

export default router;
