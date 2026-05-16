export const NOTIFICATION_TYPES = [
  'job.complete',
  'job.failed',
  'campaign.drafts_complete',
  'campaign.reply',
  'campaign.bounce',
  'crm.sync_complete',
  'crm.sync_failed',
  'budget.threshold',
  'system',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface Notification {
  _id: string;
  workspaceId: string;
  userId?: string;
  type: NotificationType;
  title: string;
  message?: string;
  href?: string;
  metadata?: Record<string, unknown>;
  readAt?: string;
  createdAt: string;
}
