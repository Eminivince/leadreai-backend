import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as suppressionController from '../controllers/suppression.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);

router.get('/', authorize(['owner', 'admin']), asyncHandler(suppressionController.listSuppression));
router.post('/', authorize(['owner', 'admin']), asyncHandler(suppressionController.addSuppression));
router.delete('/:suppressionId', authorize(['owner', 'admin']), asyncHandler(suppressionController.removeSuppression));
router.post('/check', authorize(['owner', 'admin', 'member']), asyncHandler(suppressionController.checkSuppression));

export default router;
