import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import type { NotificationType } from '../../shared/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Workers mirror the backend Notification collection with strict:false so
// we don't have to restate the full schema here.
const notificationSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Notification: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Notification'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Notification', notificationSchema);

// Lazy publisher — one per process, so workers that emit many
// notifications don't open a new Redis connection per call.
let _publisher: Redis | null = null;
function getPublisher(): Redis {
  if (!_publisher) {
    _publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    _publisher.on('error', (err) =>
      logger.warn('[notificationEmitter] publisher error', {
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return _publisher;
}

function channel(workspaceId: string): string {
  return `notifications:ws:${workspaceId}`;
}

export interface EmitNotificationInput {
  workspaceId: string;
  userId?: string;
  type: NotificationType;
  title: string;
  message?: string;
  href?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Mirror of the backend's emitNotification, for use inside worker
 * code paths. Writes to Mongo, publishes to the workspace's channel.
 * Never throws — a failed notify must not break pipeline completion.
 */
export async function emitNotification(input: EmitNotificationInput): Promise<void> {
  try {
    const doc = await Notification.create({
      workspaceId: new mongoose.Types.ObjectId(input.workspaceId),
      userId: input.userId ? new mongoose.Types.ObjectId(input.userId) : undefined,
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
        workspaceId: input.workspaceId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        href: input.href,
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
      },
    };

    getPublisher()
      .publish(channel(input.workspaceId), JSON.stringify(payload))
      .catch((err: unknown) => {
        logger.warn('[notificationEmitter] publish failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  } catch (err) {
    logger.warn('[notificationEmitter] emit failed (non-fatal)', {
      type: input.type,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
