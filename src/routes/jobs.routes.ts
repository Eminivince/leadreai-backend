import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { jobRateLimiter } from '../middleware/rateLimiter.js';
import { CreateJobSchema, ClarifyRequestSchema } from '../../shared/index.js';
import * as jobsController from '../controllers/jobs.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.post('/clarify', jobRateLimiter, validate(ClarifyRequestSchema), asyncHandler(jobsController.clarifyQuery));
router.post('/', jobRateLimiter, validate(CreateJobSchema), asyncHandler(jobsController.createJob));
router.get('/', asyncHandler(jobsController.listJobs));
router.get('/:jobId', asyncHandler(jobsController.getJob));
router.delete('/:jobId', asyncHandler(jobsController.cancelJob));

export default router;
