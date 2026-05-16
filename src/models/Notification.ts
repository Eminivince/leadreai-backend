import mongoose, { Schema } from 'mongoose';
import { NOTIFICATION_TYPES, type NotificationType } from '../../shared/index.js';

export interface INotification extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  message?: string;
  href?: string;
  metadata?: Record<string, unknown>;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    // null userId = broadcast to every member of the workspace.
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, maxlength: 200 },
    message: { type: String, maxlength: 1000 },
    href: { type: String, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed },
    readAt: { type: Date },
  },
  { timestamps: true },
);

// TTL: drop notifications 90 days after creation so the collection doesn't
// grow forever. Long enough for any reasonable "catch up" window.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
notificationSchema.index({ workspaceId: 1, createdAt: -1 });
notificationSchema.index({ workspaceId: 1, readAt: 1, createdAt: -1 });

export default mongoose.model<INotification>('Notification', notificationSchema);
