import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as ctl from '../controllers/notifications.controller.js';

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.get('/', asyncHandler(ctl.listNotifications));
router.get('/unread-count', asyncHandler(ctl.unreadCount));
router.post('/read-all', asyncHandler(ctl.markAllRead));
router.post('/:notificationId/read', asyncHandler(ctl.markRead));

export default router;
