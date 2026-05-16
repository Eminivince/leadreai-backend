import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import type { NotificationType } from '../../shared/index.js';
import { getRedis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

export function notificationChannel(workspaceId: string): string {
  return `notifications:ws:${workspaceId}`;
}

export interface EmitNotificationInput {
  workspaceId: string | mongoose.Types.ObjectId;
  userId?: string | mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  message?: string;
  href?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persist a notification and publish it to Redis so any connected SSE
 * streams push it to the client immediately. Never throws — a failed
 * notify must not break the surrounding operation.
 */
export async function emitNotification(input: EmitNotificationInput): Promise<void> {
  try {
    const doc = await Notification.create({
      workspaceId: new mongoose.Types.ObjectId(String(input.workspaceId)),
      userId: input.userId ? new mongoose.Types.ObjectId(String(input.userId)) : undefined,
      type: input.type,
      title: input.title,
      message: input.message,
      href: input.href,
      metadata: input.metadata,
    });

    const payload = {
      type: 'notification',
      notification: {
        _id: String(doc._id),
        workspaceId: String(doc.workspaceId),
        userId: doc.userId ? String(doc.userId) : undefined,
        type: doc.type,
        title: doc.title,
        message: doc.message,
        href: doc.href,
        metadata: doc.metadata,
        readAt: doc.readAt?.toISOString(),
        createdAt: doc.createdAt.toISOString(),
      },
    };

    getRedis()
      .publish(notificationChannel(String(input.workspaceId)), JSON.stringify(payload))
      .catch((err: unknown) => {
        logger.warn('[notifications] publish failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  } catch (err) {
    logger.warn('[notifications] emit failed (non-fatal)', {
      type: input.type,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
