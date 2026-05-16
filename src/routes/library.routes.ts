import { Router, type Router as RouterType } from 'express';
import multer from 'multer';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as ctl from '../controllers/library.controller.js';
import { env } from '../config/env.js';

const router: RouterType = Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.DOCUMENTS_MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.get('/', asyncHandler(ctl.listDocuments));
router.post('/', upload.single('file'), asyncHandler(ctl.uploadDocument));
router.get('/:documentId', asyncHandler(ctl.getDocument));
router.patch('/:documentId', asyncHandler(ctl.updateDocument));
router.delete('/:documentId', asyncHandler(ctl.deleteDocument));
router.get('/:documentId/chunks', asyncHandler(ctl.listChunks));
router.post('/:documentId/retry', asyncHandler(ctl.retryDocument));
router.post('/:documentId/to-file', asyncHandler(ctl.docToFile));
router.post('/:documentId/analyze', asyncHandler(ctl.analyzeDocument));

export default router;
