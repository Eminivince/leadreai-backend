import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import { ApiError } from '../utils/ApiError.js';

function userScope(userId?: mongoose.Types.ObjectId) {
  // A notification is visible to a user when it's workspace-broadcast
  // (userId null) OR directly addressed to them.
  if (!userId) return [{ userId: { $exists: false } }, { userId: null }];
  return [{ userId: { $exists: false } }, { userId: null }, { userId }];
}

export async function listNotifications(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '30'), 10) || 30));
  const unreadOnly = String(req.query['unread'] ?? '') === 'true';

  const filter: Record<string, unknown> = {
    workspaceId,
    $or: userScope(req.user._id as mongoose.Types.ObjectId),
  };
  if (unreadOnly) filter['readAt'] = { $exists: false };

  const [rows, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Notification.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: {
      data: rows.map((n) => ({
        _id: String(n._id),
        workspaceId: String(n.workspaceId),
        userId: n.userId ? String(n.userId) : undefined,
        type: n.type,
        title: n.title,
        message: n.message,
        href: n.href,
        metadata: n.metadata,
        readAt: n.readAt ? n.readAt.toISOString() : undefined,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
    },
  });
}

export async function unreadCount(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;

  const count = await Notification.countDocuments({
    workspaceId,
    readAt: { $exists: false },
    $or: userScope(req.user._id as mongoose.Types.ObjectId),
  });

  res.json({ success: true, data: { count } });
}

export async function markRead(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, notificationId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(notificationId!)) {
    throw ApiError.badRequest('Invalid notificationId');
  }

  const result = await Notification.findOneAndUpdate(
    {
      _id: notificationId,
      workspaceId,
      $or: userScope(req.user._id as mongoose.Types.ObjectId),
    },
    { $set: { readAt: new Date() } },
    { new: true },
  );

  if (!result) throw ApiError.notFound('Notification not found');
  res.json({ success: true });
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;

  await Notification.updateMany(
    {
      workspaceId,
      readAt: { $exists: false },
      $or: userScope(req.user._id as mongoose.Types.ObjectId),
    },
    { $set: { readAt: new Date() } },
  );

  res.json({ success: true });
}
