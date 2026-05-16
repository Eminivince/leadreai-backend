import Workspace from '../models/Workspace.js';
import { decrypt, encrypt } from '../utils/encrypt.js';
import { processInboundEmail } from './emailEvent.service.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

/**
 * Gmail inbound poller (Task #13).
 *
 * Customers using Gmail OAuth as their sender don't get an inbound
 * webhook the way Resend / SendGrid do — Gmail Push API exists but
 * requires Pub/Sub infrastructure we don't run. This poller is the
 * pragmatic fallback: every 5 minutes, for each workspace with a Gmail
 * refresh token, fetch any new messages since the last cursor and feed
 * them through the same processInboundEmail() that webhook deliveries
 * use. Reply pause + bounce suppress logic is shared verbatim.
 *
 * Cursor strategy: store the highest seen historyId per workspace on
 * `Workspace.emailConfig.gmail.lastHistoryId`. Gmail API lets us pull
 * everything since that historyId in one call — much cheaper than
 * polling individual message lists.
 *
 * Bounds: each poll caps at 50 messages per workspace per tick to keep
 * the worker bounded under bursty replies. Anything above that gets
 * picked up on the next tick; we never lose messages because the cursor
 * advances per processed batch, not per tick.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MESSAGES_PER_TICK = 50;

/** Refresh a Gmail access token via the refresh_token grant. Mirrors
 *  workers/src/sequence.worker.ts::refreshGmailToken so we don't share
 *  a module across processes. */
async function refreshGmailAccessToken(refreshToken: string): Promise<string | null> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    logger.warn('[gmailPoller] Google OAuth env not configured — skipping refresh');
    return null;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

interface GmailHeader { name: string; value: string }
interface GmailMessageRef { id: string; threadId: string }

async function listNewMessages(accessToken: string, startHistoryId?: string): Promise<{ messages: GmailMessageRef[]; newHistoryId?: string }> {
  // When no historyId is known we fall back to listing the last 20
  // messages from INBOX — this happens on the very first poll for a
  // workspace; subsequent polls use the cheap history API.
  if (!startHistoryId) {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('labelIds', 'INBOX');
    url.searchParams.set('maxResults', '20');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return { messages: [] };
    const json = (await res.json()) as { messages?: GmailMessageRef[]; historyId?: string };
    return { messages: json.messages ?? [], newHistoryId: json.historyId };
  }

  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
  url.searchParams.set('startHistoryId', startHistoryId);
  url.searchParams.set('historyTypes', 'messageAdded');
  url.searchParams.set('labelId', 'INBOX');
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { messages: [] };
  const json = (await res.json()) as {
    history?: Array<{ messagesAdded?: Array<{ message: GmailMessageRef }> }>;
    historyId?: string;
  };
  const messages = (json.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message));
  return { messages, newHistoryId: json.historyId };
}

async function fetchMessageHeaders(accessToken: string, messageId: string): Promise<GmailHeader[] | null> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`);
  url.searchParams.set('format', 'metadata');
  // We only need a handful of headers to correlate — pulling the full
  // message body would balloon traffic for inbox-heavy workspaces.
  for (const h of ['In-Reply-To', 'References', 'Message-ID', 'From', 'To', 'Subject']) {
    url.searchParams.append('metadataHeaders', h);
  }
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const json = (await res.json()) as { payload?: { headers?: GmailHeader[] } };
  return json.payload?.headers ?? null;
}

async function pollWorkspace(workspaceId: string): Promise<void> {
  const workspace = await Workspace.findById(workspaceId)
    .select('+emailConfig.gmail.accessToken +emailConfig.gmail.refreshToken emailConfig.gmail.email emailConfig.gmail.lastHistoryId');
  if (!workspace?.emailConfig?.gmail?.refreshToken) return;

  let accessToken = workspace.emailConfig.gmail.accessToken
    ? decrypt(workspace.emailConfig.gmail.accessToken)
    : null;
  const refreshToken = decrypt(workspace.emailConfig.gmail.refreshToken);

  // Always refresh — Gmail's hourly cap on access tokens is generous
  // but reuse of a stale token here is wasteful retries. The token is
  // re-encrypted + persisted so other code paths see it.
  const fresh = await refreshGmailAccessToken(refreshToken);
  if (!fresh) {
    logger.warn('[gmailPoller] token refresh failed — workspace likely needs reconnect', {
      workspaceId,
    });
    return;
  }
  accessToken = fresh;
  await Workspace.updateOne(
    { _id: workspaceId },
    { $set: { 'emailConfig.gmail.accessToken': encrypt(fresh) } },
  ).catch((err: unknown) => {
    logger.warn('[gmailPoller] failed to persist fresh accessToken', {
      workspaceId, err: err instanceof Error ? err.message : String(err),
    });
  });

  const cursor = (workspace.emailConfig.gmail as { lastHistoryId?: string }).lastHistoryId;
  const { messages, newHistoryId } = await listNewMessages(accessToken, cursor);

  const slice = messages.slice(0, MAX_MESSAGES_PER_TICK);
  for (const ref of slice) {
    const headers = await fetchMessageHeaders(accessToken, ref.id);
    if (!headers) continue;
    // Reshape into the same `{data: {headers: [...]}}` envelope the
    // Resend webhook handler uses — processInboundEmail's gmail branch
    // looks at this shape.
    await processInboundEmail('gmail', {
      data: { headers },
      // Carry the Gmail message + thread ids on the raw envelope so
      // EmailEvent.raw is useful for forensics.
      gmail: { messageId: ref.id, threadId: ref.threadId, workspaceId },
    }).catch((err: unknown) => {
      logger.warn('[gmailPoller] inbound processing threw', {
        workspaceId, messageId: ref.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (newHistoryId) {
    await Workspace.updateOne(
      { _id: workspaceId },
      { $set: { 'emailConfig.gmail.lastHistoryId': newHistoryId } },
    );
  }

  logger.info('[gmailPoller] tick complete', {
    workspaceId, processed: slice.length, queued: messages.length - slice.length,
    advancedCursor: Boolean(newHistoryId),
  });
}

let _timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic poller. Idempotent — repeat calls are no-ops.
 * Wire from backend/src/index.ts after the Express listener is up so
 * the first tick races nothing.
 */
export function startGmailInboundPoller(): void {
  if (_timer) return;
  logger.info('[gmailPoller] starting', { intervalMs: POLL_INTERVAL_MS });
  const tick = async (): Promise<void> => {
    try {
      const workspaces = await Workspace.find({
        'emailConfig.provider': 'gmail',
        'emailConfig.gmail.refreshToken': { $exists: true, $ne: null },
      }).select('_id').lean();
      for (const w of workspaces) {
        await pollWorkspace(String(w._id)).catch((err: unknown) => {
          logger.warn('[gmailPoller] workspace tick failed', {
            workspaceId: String(w._id),
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logger.error('[gmailPoller] tick fan-out failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // Fire immediately on boot so a freshly-deployed pod doesn't wait 5
  // min for its first sweep, then settle into the interval.
  void tick();
  _timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
}

export function stopGmailInboundPoller(): void {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
}
