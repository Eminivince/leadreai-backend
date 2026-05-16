import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as enrollmentsController from '../controllers/enrollments.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.get('/', asyncHandler(enrollmentsController.listEnrollments));
router.get('/:enrollmentId', asyncHandler(enrollmentsController.getEnrollment));
router.post('/:enrollmentId/pause', asyncHandler(enrollmentsController.pauseEnrollment));
router.post('/:enrollmentId/resume', asyncHandler(enrollmentsController.resumeEnrollment));
router.post('/:enrollmentId/stop', asyncHandler(enrollmentsController.stopEnrollment));

export default router;
