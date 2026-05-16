import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import { notificationChannel } from '../services/notifications.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * SSE stream for a workspace's notifications.
 *
 * Events emitted to the client:
 *   · {type: 'connected'}            sent on open
 *   · {type: 'bootstrap', unread}    unread count at connect time
 *   · {type: 'notification', notification}  live push
 *   · {type: 'heartbeat'}            every 30s (prevents idle timeouts)
 *
 * The filter on user visibility (broadcasts vs. direct) is applied
 * client-side via userScope rules — the SSE firehose carries every
 * notification in the workspace, and the consumer drops anything
 * addressed to other users.
 */
export async function notificationStream(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  if (!req.user) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: 'connected' });

  try {
    const unread = await Notification.countDocuments({
      workspaceId,
      readAt: { $exists: false },
      $or: [
        { userId: { $exists: false } },
        { userId: null },
        { userId: req.user._id as mongoose.Types.ObjectId },
      ],
    });
    send({ type: 'bootstrap', unread });
  } catch (err) {
    logger.warn('[notificationStream] bootstrap count failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('error', (err) => logger.error('SSE notification subscriber error', { err }));

  const channel = notificationChannel(workspaceId!);
  const userIdStr = String(req.user._id);

  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subscriber.unsubscribe(channel).catch(() => {});
    subscriber.quit().catch(() => {});
  });

  await subscriber.subscribe(channel);
  subscriber.on('message', (_chan: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as {
        type?: string;
        notification?: { userId?: string };
      };
      // Drop notifications addressed to a different user
      if (
        parsed.type === 'notification' &&
        parsed.notification?.userId &&
        parsed.notification.userId !== userIdStr
      ) {
        return;
      }
      res.write(`data: ${message}\n\n`);
    } catch {
      res.write(`data: ${message}\n\n`);
    }
  });
}
