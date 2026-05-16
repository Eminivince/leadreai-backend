import axios from 'axios';
import { logger } from '../utils/logger.js';

export interface WebhookPayload {
  event: 'job:complete' | 'job:failed';
  jobId: string;
  workspaceId: string;
  status: string;
  totalLeadsFound?: number;
  durationMs?: number;
  error?: string;
}

export function fireWebhook(url: string, payload: WebhookPayload, timeoutMs = 5000): void {
  axios
    .post(url, payload, {
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'LeadreAI-Webhook/1.0' },
    })
    .then(() => {
      logger.info('[webhook] Delivered', { url, event: payload.event });
    })
    .catch((err: unknown) => {
      logger.warn('[webhook] Delivery failed', {
        url,
        event: payload.event,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}
