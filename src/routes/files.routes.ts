import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as filesController from '../controllers/files.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);

const anyRole = authorize(['owner', 'admin', 'member']);
const writer = authorize(['owner', 'admin', 'member']);

router.get('/', anyRole, asyncHandler(filesController.listFiles));
router.post('/', writer, asyncHandler(filesController.createFile));

router.get('/:fileId', anyRole, asyncHandler(filesController.getFile));
router.patch('/:fileId', writer, asyncHandler(filesController.updateFile));
router.delete('/:fileId', writer, asyncHandler(filesController.deleteFile));

router.get('/:fileId/leads', anyRole, asyncHandler(filesController.listFileLeads));
router.post('/:fileId/leads', writer, asyncHandler(filesController.addLeadsToFile));
router.delete('/:fileId/leads', writer, asyncHandler(filesController.removeLeadsFromFile));

export default router;
