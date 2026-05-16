import EmailEvent from '../models/EmailEvent.js';
import SequenceEnrollment, { type ISequenceEnrollmentDoc } from '../models/SequenceEnrollment.js';
import Sequence from '../models/Sequence.js';
import Campaign from '../models/Campaign.js';
import Lead from '../models/Lead.js';
import OutreachDraft from '../models/OutreachDraft.js';
import { SuppressionEntry } from '../models/SuppressionList.js';
import { emitNotification } from './notifications.js';
import { logger } from '../utils/logger.js';

interface NormalizedEvent {
  workspaceId?: string;
  messageId: string;
  event: 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained' | 'replied' | 'unsubscribed';
  provider: 'resend' | 'sendgrid';
  bounceType?: 'hard' | 'soft';
  occurredAt: Date;
  raw: Record<string, unknown>;
  recipientEmail?: string;
}

function normalizeResend(payload: Record<string, unknown>): NormalizedEvent | null {
  const type = payload['type'] as string | undefined;
  const data = payload['data'] as Record<string, unknown> | undefined;
  if (!data) return null;

  const emailId = data['email_id'] as string | undefined;
  const to = (data['to'] as string[] | undefined)?.[0];

  const eventMap: Record<string, NormalizedEvent['event']> = {
    'email.delivered': 'delivered',
    'email.opened': 'opened',
    'email.clicked': 'clicked',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
  };

  const event = type ? eventMap[type] : undefined;
  if (!event || !emailId) return null;

  const isSoftBounce = typeof data['bounce_type'] === 'string' && (data['bounce_type'] as string).toLowerCase() === 'soft';

  return {
    messageId: emailId,
    event,
    provider: 'resend',
    bounceType: event === 'bounced' ? (isSoftBounce ? 'soft' : 'hard') : undefined,
    occurredAt: new Date((data['created_at'] as string | undefined) ?? Date.now()),
    raw: payload,
    recipientEmail: to,
  };
}

function normalizeSendGrid(payload: Record<string, unknown>): NormalizedEvent | null {
  const sgEvent = payload['event'] as string | undefined;
  const messageId = (payload['smtp-id'] as string | undefined) ?? (payload['sg_message_id'] as string | undefined);
  if (!sgEvent || !messageId) return null;

  const eventMap: Record<string, NormalizedEvent['event']> = {
    delivered: 'delivered',
    open: 'opened',
    click: 'clicked',
    bounce: 'bounced',
    spamreport: 'complained',
    unsubscribe: 'unsubscribed',
  };
  const event = eventMap[sgEvent];
  if (!event) return null;

  const type = payload['type'] as string | undefined;
  const ts = payload['timestamp'] as number | undefined;
  return {
    messageId: messageId.split('.')[0] ?? messageId,
    event,
    provider: 'sendgrid',
    bounceType: event === 'bounced' ? (type === 'bounce' ? 'hard' : 'soft') : undefined,
    occurredAt: ts !== undefined ? new Date(ts * 1000) : new Date(),
    raw: payload,
    recipientEmail: payload['email'] as string | undefined,
  };
}

async function applyStopRules(
  enrollment: ISequenceEnrollmentDoc,
  event: NormalizedEvent['event'],
): Promise<boolean> {
  if (!enrollment) return false;
  const sequence = await Sequence.findById(enrollment.sequenceId).select('stopRules stats');
  if (!sequence) return false;

  for (const rule of sequence.stopRules) {
    const triggered =
      (rule.trigger === 'any_reply' && event === 'replied') ||
      (rule.trigger === 'unsubscribe' && event === 'unsubscribed') ||
      (rule.trigger === 'bounce' && event === 'bounced');

    if (triggered && rule.action === 'stop_sequence') {
      await SequenceEnrollment.updateOne(
        { _id: enrollment._id },
        { $set: { status: 'stopped', stopReason: rule.trigger, completedAt: new Date() } },
      );
      await Sequence.updateOne(
        { _id: sequence._id, 'stats.active': { $gt: 0 } },
        { $inc: { 'stats.active': -1 } },
      );
      return true;
    }
  }
  return false;
}

async function handleReplyForEnrollment(
  enrollment: ISequenceEnrollmentDoc,
  messageId: string,
  occurredAt: Date,
  stepIndex: number,
  recipientEmail?: string,
): Promise<void> {
  const isFirst = enrollment.status !== 'replied';
  const historyUpdate: Record<string, unknown> = {};

  if (stepIndex >= 0) {
    historyUpdate[`stepHistory.${stepIndex}.repliedAt`] = occurredAt;
    historyUpdate[`stepHistory.${stepIndex}.status`] = 'replied';
  }

  await SequenceEnrollment.updateOne(
    { _id: enrollment._id },
    { $set: { ...historyUpdate, status: 'replied' } },
  );

  if (isFirst) {
    await Sequence.updateOne({ _id: enrollment.sequenceId }, { $inc: { 'stats.replied': 1 } });
  }

  const campaign = await Campaign.findOne({
    sequenceId: enrollment.sequenceId,
    workspaceId: enrollment.workspaceId,
  }).select('_id name');

  if (isFirst && campaign) {
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.replied': 1 } });
    const lead = await Lead.findById(enrollment.leadId).select('companyName emails');
    await emitNotification({
      workspaceId: enrollment.workspaceId,
      type: 'campaign.reply',
      title: `Reply from ${lead?.companyName ?? recipientEmail ?? 'a lead'}`,
      message: `${campaign.name ?? 'Campaign'} — sequence paused for this lead.`,
      href: `/dashboard/campaigns/${String(campaign._id)}`,
      metadata: {
        enrollmentId: String(enrollment._id),
        leadId: String(enrollment.leadId),
        campaignId: String(campaign._id),
      },
    });
  }

  await applyStopRules(enrollment, 'replied');
}

function normalizeMessageIdRef(raw: string, provider: 'resend' | 'sendgrid' | 'gmail'): string {
  // Strip angle brackets: "<re_abc@resend.dev>" → "re_abc@resend.dev"
  // Then strip domain part.
  // SendGrid SMTP IDs have a ".filterXXX" suffix; strip it to match stored values.
  // Resend IDs are opaque tokens — do not truncate.
  // Gmail Message-IDs look like "<CABc123@mail.gmail.com>" — same handling as Resend.
  const stripped = raw.trim().replace(/^<|>$/g, '');
  const atIdx = stripped.indexOf('@');
  const local = atIdx >= 0 ? stripped.slice(0, atIdx) : stripped;
  return provider === 'sendgrid' ? (local.split('.')[0] ?? local) : local;
}

function extractInReplyTo(provider: 'resend' | 'sendgrid' | 'gmail', payload: Record<string, unknown>): string | null {
  if (provider === 'resend' || provider === 'gmail') {
    // Both pass headers as an array of {name, value}. Gmail's poller
    // reshapes the Gmail API payload into the same shape for reuse.
    const data = payload['data'] as Record<string, unknown> | undefined;
    const headers =
      (data?.['headers'] as Array<{ name: string; value: string }> | undefined) ??
      (payload['headers'] as Array<{ name: string; value: string }> | undefined) ??
      [];
    const h = headers.find(hdr => hdr.name.toLowerCase() === 'in-reply-to');
    if (!h?.value) return null;
    const m = h.value.match(/<([^>]+)>/);
    return m ? `<${m[1]}>` : h.value.trim();
  }
  // SendGrid Inbound Parse: 'headers' is a CRLF-delimited text string
  const headersText = (payload['headers'] as string | undefined) ?? '';
  const m = headersText.match(/^In-Reply-To:\s*(<[^>]+>)/im);
  if (m?.[1]) return m[1];
  // Fallback: bare token without angle brackets
  const bare = headersText.match(/^In-Reply-To:\s*(\S+)/im);
  return bare?.[1]?.trim() ?? null;
}

export async function processEmailEvent(
  provider: 'resend' | 'sendgrid',
  rawPayload: Record<string, unknown>,
): Promise<void> {
  const normalized = provider === 'resend'
    ? normalizeResend(rawPayload)
    : normalizeSendGrid(rawPayload);

  if (!normalized) {
    logger.warn('[emailEvent] Could not normalize event', { provider, type: rawPayload['type'] ?? rawPayload['event'] });
    return;
  }

  // Find enrollment by messageId in step history
  const enrollment = await SequenceEnrollment.findOne({
    'stepHistory.messageId': normalized.messageId,
  });

  if (!enrollment) {
    logger.info('[emailEvent] No enrollment found for messageId', { messageId: normalized.messageId });
    return;
  }

  // Save event record (workspaceId is required — only create after enrollment confirmed)
  await EmailEvent.create({
    workspaceId: enrollment.workspaceId,
    enrollmentId: enrollment._id,
    messageId: normalized.messageId,
    event: normalized.event,
    provider: normalized.provider,
    bounceType: normalized.bounceType,
    raw: normalized.raw,
    occurredAt: normalized.occurredAt,
  });

  const stepIndex = enrollment.stepHistory.findIndex(s => s.messageId === normalized.messageId);
  const step = stepIndex >= 0 ? enrollment.stepHistory[stepIndex] : undefined;
  const historyUpdate: Record<string, unknown> = {};

  // Campaign.stats is the cache the dashboard reads. We only $inc on the
  // FIRST transition per enrollment so duplicate provider deliveries don't
  // double-count. Discriminator = did the enrollment already record this
  // state? (checked via the stepHistory timestamp field per event type).
  const campaign = await Campaign.findOne({ sequenceId: enrollment.sequenceId, workspaceId: enrollment.workspaceId }).select('_id name stats.replied stats.bounced stats.opened');

  switch (normalized.event) {
    case 'delivered':
      historyUpdate[`stepHistory.${stepIndex}.deliveredAt`] = normalized.occurredAt;
      historyUpdate[`stepHistory.${stepIndex}.status`] = 'delivered';
      break;
    case 'opened': {
      const isFirst = stepIndex >= 0 && !step?.openedAt;
      historyUpdate[`stepHistory.${stepIndex}.openedAt`] = normalized.occurredAt;
      historyUpdate[`stepHistory.${stepIndex}.status`] = 'opened';
      if (isFirst && campaign) {
        await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.opened': 1 } });
      }
      break;
    }
    case 'clicked':
      historyUpdate[`stepHistory.${stepIndex}.clickedAt`] = normalized.occurredAt;
      historyUpdate[`stepHistory.${stepIndex}.status`] = 'clicked';
      break;
    case 'replied': {
      await handleReplyForEnrollment(enrollment, normalized.messageId, normalized.occurredAt, stepIndex, normalized.recipientEmail);
      break;
    }
    case 'bounced': {
      const wasNotBounced = enrollment.status !== 'bounced';
      historyUpdate[`stepHistory.${stepIndex}.bouncedAt`] = normalized.occurredAt;
      historyUpdate[`stepHistory.${stepIndex}.status`] = 'bounced';
      historyUpdate[`stepHistory.${stepIndex}.bounceType`] = normalized.bounceType;

      if (normalized.bounceType === 'hard') {
        // Hard bounce: suppress email + stop enrollment + update lead
        if (normalized.recipientEmail) {
          const workspaceId = enrollment.workspaceId.toString();
          await SuppressionEntry.updateOne(
            { workspaceId, email: normalized.recipientEmail.toLowerCase() },
            { $setOnInsert: { workspaceId, email: normalized.recipientEmail.toLowerCase(), reason: 'bounce', addedAt: new Date() } },
            { upsert: true },
          );
          await Lead.updateOne(
            { _id: enrollment.leadId },
            { $set: { outreachStatus: 'bounced', suppressedAt: new Date(), suppressReason: 'hard_bounce' } },
          );
        }
        await SequenceEnrollment.updateOne(
          { _id: enrollment._id },
          { $set: { status: 'bounced', stopReason: 'hard_bounce', completedAt: new Date() } },
        );
        await Sequence.updateOne(
          { _id: enrollment.sequenceId, 'stats.active': { $gt: 0 } },
          { $inc: { 'stats.bounced': 1, 'stats.active': -1 } },
        );
        if (wasNotBounced && campaign) {
          await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.bounced': 1 } });
          await emitNotification({
            workspaceId: enrollment.workspaceId,
            type: 'campaign.bounce',
            title: `Hard bounce on ${campaign.name ?? 'campaign'}`,
            message: `${normalized.recipientEmail ?? 'A recipient'} was added to your suppression list.`,
            href: `/dashboard/campaigns/${String(campaign._id)}`,
            metadata: { enrollmentId: String(enrollment._id), leadId: String(enrollment.leadId), campaignId: String(campaign._id), email: normalized.recipientEmail },
          });
        }
      }
      break;
    }
    case 'complained':
      // Treat like hard bounce
      if (normalized.recipientEmail) {
        const workspaceId = enrollment.workspaceId.toString();
        await SuppressionEntry.updateOne(
          { workspaceId, email: normalized.recipientEmail.toLowerCase() },
          { $setOnInsert: { workspaceId, email: normalized.recipientEmail.toLowerCase(), reason: 'manual', addedAt: new Date() } },
          { upsert: true },
        );
        await Lead.updateOne({ _id: enrollment.leadId }, { $set: { outreachStatus: 'bounced', suppressedAt: new Date(), suppressReason: 'spam_complaint' } });
      }
      await SequenceEnrollment.updateOne(
        { _id: enrollment._id },
        { $set: { status: 'stopped', stopReason: 'spam_complaint', completedAt: new Date() } },
      );
      await Sequence.updateOne(
        { _id: enrollment.sequenceId, 'stats.active': { $gt: 0 } },
        { $inc: { 'stats.active': -1 } },
      );
      break;
    case 'unsubscribed':
      await SequenceEnrollment.updateOne(
        { _id: enrollment._id },
        { $set: { status: 'unsubscribed', stopReason: 'unsubscribe', completedAt: new Date() } },
      );
      await Sequence.updateOne(
        { _id: enrollment.sequenceId, 'stats.active': { $gt: 0 } },
        { $inc: { 'stats.unsubscribed': 1, 'stats.active': -1 } },
      );
      break;
  }

  if (Object.keys(historyUpdate).length > 0 && stepIndex >= 0) {
    await SequenceEnrollment.updateOne({ _id: enrollment._id }, { $set: historyUpdate });
  }
}

/**
 * Pull the fields the reply classifier needs out of a provider payload.
 * Each provider stuffs them in different places; this collapses them
 * into a single shape so the classifier itself stays provider-agnostic.
 */
function extractClassifierFields(provider: 'resend' | 'sendgrid' | 'gmail', payload: Record<string, unknown>): {
  from?: string; subject?: string; bodyText?: string; headers: Record<string, string>;
} {
  if (provider === 'sendgrid') {
    const headersText = (payload['headers'] as string | undefined) ?? '';
    const headers: Record<string, string> = {};
    for (const line of headersText.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return {
      from: payload['from'] as string | undefined,
      subject: payload['subject'] as string | undefined,
      bodyText: (payload['text'] as string | undefined) ?? (payload['plain'] as string | undefined),
      headers,
    };
  }
  // Resend + Gmail both shape headers as [{name, value}].
  const data = payload['data'] as Record<string, unknown> | undefined;
  const arr =
    (data?.['headers'] as Array<{ name: string; value: string }> | undefined) ??
    (payload['headers'] as Array<{ name: string; value: string }> | undefined) ??
    [];
  const headers: Record<string, string> = {};
  for (const h of arr) headers[h.name.toLowerCase()] = h.value;
  return {
    from: (data?.['from'] as string | undefined) ?? headers['from'],
    subject: (data?.['subject'] as string | undefined) ?? headers['subject'],
    bodyText:
      (data?.['text'] as string | undefined) ??
      (payload['snippet'] as string | undefined) ?? // Gmail API snippet — short but enough for classifier
      undefined,
    headers,
  };
}

export async function processInboundEmail(
  provider: 'resend' | 'sendgrid' | 'gmail',
  payload: Record<string, unknown>,
): Promise<void> {
  const rawRef = extractInReplyTo(provider, payload);
  if (!rawRef) {
    logger.info('[emailEvent/inbound] no In-Reply-To header', { provider });
    return;
  }

  const messageId = normalizeMessageIdRef(rawRef, provider);
  if (!messageId) {
    logger.warn('[emailEvent/inbound] could not normalize In-Reply-To', { rawRef });
    return;
  }

  const occurredAt = new Date();
  // Reply classification (Task #16). Runs unconditionally so the
  // `unknown` bucket carries real volume — that's how we judge the
  // classifier's calibration over time.
  const { classifyReply } = await import('./replyClassifier.js');
  const classifierFields = extractClassifierFields(provider, payload);
  const classification = classifyReply(classifierFields);

  // Primary: sequence enrollment path
  const enrollment = await SequenceEnrollment.findOne({
    'stepHistory.messageId': messageId,
  });

  if (enrollment) {
    await EmailEvent.create({
      workspaceId: enrollment.workspaceId,
      enrollmentId: enrollment._id,
      messageId,
      event: 'replied',
      provider,
      classification,
      raw: payload,
      occurredAt,
    });
    const stepIndex = enrollment.stepHistory.findIndex(s => s.messageId === messageId);
    await handleReplyForEnrollment(enrollment, messageId, occurredAt, stepIndex);
    return;
  }

  // Fallback: direct OutreachDraft send (no SequenceEnrollment)
  const draft = await OutreachDraft.findOne({
    'deliveryMetadata.messageId': messageId,
  }).select('_id campaignId leadId workspaceId');

  if (!draft) {
    // workspaceId is required on EmailEvent — skip creating an orphan record
    logger.info('[emailEvent/inbound] no enrollment or draft for messageId', { messageId });
    return;
  }

  await EmailEvent.create({
    workspaceId: draft.workspaceId,
    messageId,
    event: 'replied',
    provider,
    classification,
    raw: payload,
    occurredAt,
  });

  const campaign = await Campaign.findOne({
    _id: draft.campaignId,
    workspaceId: draft.workspaceId,
  }).select('_id name');

  if (campaign) {
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.replied': 1 } });
    const lead = await Lead.findById(draft.leadId).select('companyName');
    await emitNotification({
      workspaceId: draft.workspaceId,
      type: 'campaign.reply',
      title: `Reply from ${lead?.companyName ?? 'a lead'}`,
      message: `${campaign.name ?? 'Campaign'} — reply received.`,
      href: `/dashboard/campaigns/${String(campaign._id)}`,
      metadata: {
        draftId: String(draft._id),
        leadId: String(draft.leadId),
        campaignId: String(campaign._id),
      },
    });
  }
}
