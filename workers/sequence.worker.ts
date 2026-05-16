import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose, { Schema } from 'mongoose';
import { scryptSync, createDecipheriv, createCipheriv, randomBytes } from 'crypto';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { renderTemplate } from './services/templateRenderer.js';
import { isWithinSendWindow, nextSendTime, type SendWindow } from './services/sendWindowChecker.js';
import { reserveSend } from './services/sendQuota.js';
import { generateOutreachDraft } from './services/outreachGenerator.js';
import { runWithCostContext } from './services/costTracker.js';
import type {
  IWorkspaceSeq,
  ILeadSeq,
  IContactSeq,
  IEnrollmentSeq,
  ISequenceSeq,
  ISuppressionSeq,
  IProspectingJobSeq,
  ICampaignSeq,
  IOutreachDraftSeq,
  EmailConfig,
} from './types/sequenceModels.js';

export interface SequenceStepPayload {
  enrollmentId: string;
  stepNumber: number;
}

const QUEUE_PREFIX = `{bull}:leadreai:${env.NODE_ENV}`;

// ─── Inline encrypt/decrypt (mirrors backend/src/utils/encrypt.ts) ───────────
function decryptValue(ciphertext: string): string {
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) throw new Error('Invalid ciphertext format');
  const key = scryptSync(env.JWT_SECRET, 'leadreai-email-salt', 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return decipher.update(Buffer.from(encryptedHex, 'hex')) + decipher.final('utf8');
}

function encryptValue(text: string): string {
  const key = scryptSync(env.JWT_SECRET, 'leadreai-email-salt', 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

// ─── Inline unsubscribe token generation ─────────────────────────────────────
function buildUnsubscribeUrl(workspaceId: string, email: string): string {
  const secret = env.UNSUBSCRIBE_TOKEN_SECRET ?? env.JWT_SECRET;
  const token = jwt.sign({ wid: workspaceId, email: email.toLowerCase() }, secret, { expiresIn: '30d' });
  return `${env.UNSUBSCRIBE_BASE_URL}?t=${token}`;
}

// ─── Inline Mongoose models (minimal field sets) ──────────────────────────────

// Workspace — only emailConfig needed
const workspaceSchema = new Schema({
  emailConfig: {
    provider: String,
    fromEmail: String,
    fromName: String,
    replyTo: String,
    apiKey: { type: String, select: false },
    smtpHost: String,
    smtpPort: Number,
    smtpSecure: Boolean,
    smtpUser: String,
    smtpPass: { type: String, select: false },
    gmail: {
      accessToken: { type: String, select: false },
      refreshToken: { type: String, select: false },
      expiresAt: Date,
      email: String,
    },
  },
}, { strict: false });

const WorkspaceModel =
  (mongoose.models['WS_SEQ'] as mongoose.Model<IWorkspaceSeq> | undefined) ??
  mongoose.model<IWorkspaceSeq>('WS_SEQ', workspaceSchema, 'workspaces');

// Lead — companyName, industry, address, website, companyDomain, emails
const leadSchema = new Schema({
  companyName: String,
  companyDomain: String,
  industry: String,
  website: String,
  address: { city: String, country: String },
  emails: [{ address: String, type: String }],
  jobId: Schema.Types.ObjectId,
  qualificationReason: String,
  agentReasoning: String,
  socialProfiles: { linkedinUrl: String },
  facts: { type: Schema.Types.Mixed },
}, { strict: false });

const LeadModel =
  (mongoose.models['LEAD_SEQ'] as mongoose.Model<ILeadSeq> | undefined) ??
  mongoose.model<ILeadSeq>('LEAD_SEQ', leadSchema, 'leads');

// Contact — firstName, lastName, fullName, title
const contactSchema = new Schema({
  firstName: String,
  lastName: String,
  fullName: String,
  title: String,
}, { strict: false });

const ContactModel =
  (mongoose.models['CONTACT_SEQ'] as mongoose.Model<IContactSeq> | undefined) ??
  mongoose.model<IContactSeq>('CONTACT_SEQ', contactSchema, 'contacts');

// SequenceEnrollment — full shape needed for state machine updates
const enrollmentSchema = new Schema({
  workspaceId: Schema.Types.ObjectId,
  sequenceId: Schema.Types.ObjectId,
  leadId: Schema.Types.ObjectId,
  contactId: Schema.Types.ObjectId,
  status: String,
  currentStep: Number,
  nextStepAt: Date,
  completedAt: Date,
  stopReason: String,
  stepHistory: [{
    stepNumber: Number,
    sentAt: Date,
    status: String,
    messageId: String,
    errorMessage: String,
    toEmail: String,
    _id: false,
  }],
}, { strict: false, timestamps: true });

const EnrollmentModel =
  (mongoose.models['ENROLLMENT_SEQ'] as mongoose.Model<IEnrollmentSeq> | undefined) ??
  mongoose.model<IEnrollmentSeq>('ENROLLMENT_SEQ', enrollmentSchema, 'sequenceenrollments');

// Sequence — steps and stopRules
const sequenceSchema = new Schema({
  workspaceId: Schema.Types.ObjectId,
  status: String,
  steps: [{ stepNumber: Number, channel: String, delayDays: Number, sendWindow: Schema.Types.Mixed, emailTemplate: Schema.Types.Mixed, _id: false }],
  stopRules: [{ trigger: String, action: String, _id: false }],
}, { strict: false });

const SequenceModel =
  (mongoose.models['SEQ_MODEL'] as mongoose.Model<ISequenceSeq> | undefined) ??
  mongoose.model<ISequenceSeq>('SEQ_MODEL', sequenceSchema, 'sequences');

// SuppressionEntry — email + domain
const suppressionSchema = new Schema({ workspaceId: Schema.Types.ObjectId, email: String, domain: String }, { strict: false });
const SuppressionModel =
  (mongoose.models['SUPPRESSION_SEQ'] as mongoose.Model<ISuppressionSeq> | undefined) ??
  mongoose.model<ISuppressionSeq>('SUPPRESSION_SEQ', suppressionSchema, 'suppressionentries');

// ProspectingJob — read rawQuery to give the AI context about why this lead was found
const prospectingJobSchema = new Schema({ rawQuery: String }, { strict: false });
const ProspectingJobModel =
  (mongoose.models['PROSJOB_SEQ'] as mongoose.Model<IProspectingJobSeq> | undefined) ??
  mongoose.model<IProspectingJobSeq>('PROSJOB_SEQ', prospectingJobSchema, 'prospectingjobs');

// Campaign — we read `schedule.dailySendCap` + `schedule.timezone` per-send
// to enforce the per-workspace daily cap. Matched to a sequence via
// `sequenceId`. Campaigns created before M1 won't have `schedule`; the
// send path falls back to no-cap in that case.
const campaignSchema = new Schema({
  workspaceId: Schema.Types.ObjectId,
  sequenceId: Schema.Types.ObjectId,
  name: String,
  description: String,
  outreachConfig: { channel: String, tone: String, language: String },
  schedule: { timezone: String, startHour: Number, endHour: Number, allowedDays: [Number], dailySendCap: Number },
}, { strict: false });
const CampaignModel =
  (mongoose.models['CAMPAIGN_SEQ'] as mongoose.Model<ICampaignSeq> | undefined) ??
  mongoose.model<ICampaignSeq>('CAMPAIGN_SEQ', campaignSchema, 'campaigns');

// OutreachDraft — persisted for every AI-personalized send so the audit
// trail contains the exact subject/body the model produced. Drafts from
// template-rendered sends are NOT persisted here (they're reproducible
// from the step template + merge tokens).
const outreachDraftSchema = new Schema({
  workspaceId: Schema.Types.ObjectId,
  campaignId: Schema.Types.ObjectId,
  leadId: Schema.Types.ObjectId,
  createdBy: Schema.Types.ObjectId,
  channel: { type: String, default: 'email' },
  firstLine: String,
  subject: String,
  body: String,
  tone: String,
  language: String,
  reasoning: String,
  status: { type: String, default: 'sent' },
  sentAt: Date,
  deliveryMetadata: { provider: String, messageId: String },
}, { strict: false, timestamps: true });
const OutreachDraftModel =
  (mongoose.models['DRAFT_SEQ'] as mongoose.Model<IOutreachDraftSeq> | undefined) ??
  mongoose.model<IOutreachDraftSeq>('DRAFT_SEQ', outreachDraftSchema, 'outreachdrafts');

// ─── Gmail send helper ────────────────────────────────────────────────────────
async function refreshGmailToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    refresh_token: refreshToken,
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error('Gmail token refresh failed');
  const data = await resp.json() as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000) };
}

async function sendViaGmailWorker(
  emailConfig: EmailConfig,
  workspaceId: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<string> {
  const gmail = emailConfig.gmail;
  if (!gmail?.accessToken) throw new Error('Gmail not configured for this workspace');

  let accessToken = decryptValue(gmail.accessToken);

  if (gmail.refreshToken && gmail.expiresAt) {
    const fiveMin = 5 * 60 * 1000;
    if (new Date(gmail.expiresAt).getTime() - Date.now() < fiveMin) {
      const refreshed = await refreshGmailToken(decryptValue(gmail.refreshToken));
      accessToken = refreshed.accessToken;
      await WorkspaceModel.findByIdAndUpdate(workspaceId, {
        $set: {
          'emailConfig.gmail.accessToken': encryptValue(refreshed.accessToken),
          'emailConfig.gmail.expiresAt': refreshed.expiresAt,
        },
      }).catch(() => {/* non-critical: send still proceeds with fresh token in memory */});
    }
  }

  const from = emailConfig.fromName
    ? `${emailConfig.fromName} <${emailConfig.fromEmail ?? ''}>`
    : emailConfig.fromEmail ?? '';
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(emailConfig.replyTo ? [`Reply-To: ${emailConfig.replyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlBody,
  ];
  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sendResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!sendResp.ok) {
    const errBody = await sendResp.text();
    throw new Error(`Gmail send failed (${sendResp.status}): ${errBody}`);
  }
  const result = await sendResp.json() as { id: string };
  return result.id;
}

// ─── Email send helper ────────────────────────────────────────────────────────
async function sendEmail(
  emailConfig: EmailConfig,
  workspaceId: string,
  to: string,
  subject: string,
  body: string,
  unsubscribeUrl: string,
  // Idempotency key — provider-side dedup so a BullMQ retry after a
  // partial-success response doesn't double-send. Built upstream from
  // `{enrollmentId, stepNumber}` so the same step always reuses the key.
  idempotencyKey?: string,
): Promise<string> {
  const footerHtml = `<br><br><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:11px;color:#999;font-family:sans-serif">To unsubscribe: <a href="${unsubscribeUrl}">${unsubscribeUrl}</a></p>`;
  const footerText = `\n\n---\nTo unsubscribe: ${unsubscribeUrl}`;
  const htmlBody = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#333">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>${footerHtml}`;
  const textBody = body + footerText;
  const headers: Record<string, string> = {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  // Gmail send dedups internally by a SMTP Message-ID. Resend supports an
  // explicit `Idempotency-Key` request header per their docs; setting it
  // here lets a retry collapse to the original send rather than a fresh
  // delivery.
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  if (emailConfig.provider === 'gmail') {
    return sendViaGmailWorker(emailConfig, workspaceId, to, subject, htmlBody);
  }

  if (emailConfig.provider === 'resend') {
    if (!emailConfig.apiKey) throw new Error('Resend API key not configured for this workspace');
    const apiKey = decryptValue(emailConfig.apiKey);
    const resend = new Resend(apiKey);
    const from = `${emailConfig.fromName ?? ''} <${emailConfig.fromEmail ?? ''}>`;
    const { data, error } = await resend.emails.send({ from, to, subject, html: htmlBody, text: textBody, headers });
    if (error || !data) throw new Error(error?.message ?? 'Resend send failed');
    return data.id;
  }

  if (emailConfig.provider === 'sendgrid' && !emailConfig.apiKey) {
    throw new Error('SendGrid API key not configured for this workspace');
  }
  const smtpConfig =
    emailConfig.provider === 'sendgrid'
      ? { host: 'smtp.sendgrid.net', port: 587, auth: { user: 'apikey', pass: decryptValue(emailConfig.apiKey ?? '') } }
      : {
          host: emailConfig.smtpHost ?? '',
          port: emailConfig.smtpPort ?? 587,
          secure: emailConfig.smtpSecure ?? false,
          auth: emailConfig.smtpUser ? { user: emailConfig.smtpUser, pass: decryptValue(emailConfig.smtpPass ?? '') } : undefined,
        };

  const transporter = nodemailer.createTransport(smtpConfig);
  const info = await transporter.sendMail({
    from: `"${emailConfig.fromName ?? ''}" <${emailConfig.fromEmail ?? ''}>`,
    to,
    subject,
    html: htmlBody,
    text: textBody,
    headers,
  });
  return String(info.messageId);
}

// ─── Main job processor ───────────────────────────────────────────────────────
async function processSequenceStep(job: Job<SequenceStepPayload>, redis: Redis): Promise<void> {
  const { enrollmentId, stepNumber } = job.data;
  const tag = `[sequence.worker:${enrollmentId}:step${stepNumber}]`;

  const enrollment = await EnrollmentModel.findById(enrollmentId);
  if (!enrollment) { logger.warn(`${tag} enrollment not found`); return; }
  if (enrollment.status !== 'active') { logger.info(`${tag} enrollment not active (${String(enrollment.status)}), skipping`); return; }
  if (enrollment.currentStep !== stepNumber) { logger.info(`${tag} step mismatch (current=${String(enrollment.currentStep)})`); return; }

  const sequence = await SequenceModel.findById(enrollment.sequenceId);
  if (!sequence || sequence.status === 'archived') { logger.warn(`${tag} sequence not found or archived`); return; }

  const step = sequence.steps.find((s) => s.stepNumber === stepNumber);
  if (!step) { logger.warn(`${tag} step definition not found`); return; }

  // Only email steps supported in this implementation
  if (step.channel !== 'email' || !step.emailTemplate) {
    logger.info(`${tag} non-email step or no template, marking completed`);
    await advanceOrComplete(enrollment, sequence, step, null, null);
    return;
  }

  const lead = await LeadModel.findById(enrollment.leadId);
  if (!lead) { logger.warn(`${tag} lead not found`); return; }

  const toEmail = lead.emails?.[0]?.address;
  if (!toEmail) { logger.warn(`${tag} lead has no email`); return; }

  // Check suppression
  const domain = toEmail.split('@')[1] ?? '';
  const suppressed = await SuppressionModel.findOne({
    workspaceId: enrollment.workspaceId,
    $or: [{ email: toEmail.toLowerCase() }, { domain }],
  });
  if (suppressed) {
    logger.info(`${tag} email suppressed, skipping step`);
    const histEntry = { stepNumber, status: 'skipped', toEmail };
    await EnrollmentModel.updateOne({ _id: enrollmentId }, { $push: { stepHistory: histEntry } });
    await advanceOrComplete(enrollment, sequence, step, null, null);
    return;
  }

  // Check send window
  if (step.sendWindow) {
    const sw = step.sendWindow as SendWindow;
    if (!isWithinSendWindow(sw, new Date())) {
      const nextTime = nextSendTime(sw, new Date());
      logger.info(`${tag} outside send window, rescheduling to ${nextTime.toISOString()}`);
      await EnrollmentModel.updateOne({ _id: enrollmentId }, { $set: { nextStepAt: nextTime } });
      return; // Scheduler will re-dispatch
    }
  }

  // Load workspace for email config
  const workspace = await WorkspaceModel.findById(enrollment.workspaceId).select('+emailConfig.apiKey +emailConfig.smtpPass +emailConfig.gmail.accessToken +emailConfig.gmail.refreshToken');
  if (!workspace?.emailConfig) {
    logger.error(`${tag} workspace has no email config`);
    return;
  }

  // Daily send cap — look up the Campaign associated with this sequence.
  // Campaigns created before M1 won't have a schedule; skip the check in
  // that case. When the cap is hit, defer nextStepAt to the start of the
  // next send window (tomorrow) and don't advance the step.
  const campaign = await CampaignModel.findOne({
    sequenceId: enrollment.sequenceId,
    workspaceId: enrollment.workspaceId,
  }).select('schedule').lean();
  const cap = campaign?.schedule?.dailySendCap;
  const stepSw = step.sendWindow as { timezone?: string } | undefined;
  const tz = campaign?.schedule?.timezone ?? stepSw?.timezone;
  if (cap && tz) {
    const quota = await reserveSend({
      redis,
      workspaceId: enrollment.workspaceId.toString(),
      timezone: tz,
      cap,
    });
    if (!quota.allowed) {
      // Defer to the next valid send window — sequenceScheduler will
      // re-dispatch when nextStepAt passes. We add 24h and let
      // nextSendTime jump forward to the workspace-local startHour.
      const deferBase = new Date(Date.now() + 24 * 3_600_000);
      const cs = campaign?.schedule;
      // Construct a SendWindow from either the step's own definition or the
      // campaign schedule. Null defaults are only safe when none of the
      // hours/timezone are set; otherwise we coerce to sensible defaults.
      const sw: SendWindow | null = step.sendWindow
        ? (step.sendWindow as SendWindow)
        : cs && tz
          ? {
              startHour: cs.startHour ?? 9,
              endHour: cs.endHour ?? 17,
              timezone: tz,
              allowedDays: cs.allowedDays ?? [],
            }
          : null;
      const nextTime = sw ? nextSendTime(sw, deferBase) : deferBase;
      logger.info(`${tag} daily cap hit (${quota.used}/${quota.cap}), deferring to ${nextTime.toISOString()}`);
      await EnrollmentModel.updateOne(
        { _id: enrollmentId },
        {
          $set: { nextStepAt: nextTime },
          $push: { stepHistory: { stepNumber, status: 'skipped', toEmail, errorMessage: `daily cap ${cap} reached` } },
        },
      );
      return;
    }
  }

  // Render template (fallback + non-AI path)
  const contact = enrollment.contactId ? await ContactModel.findById(enrollment.contactId) : null;
  const templateSubject = renderTemplate(step.emailTemplate.subject as string, lead, contact ?? undefined);
  const templateBody = renderTemplate(step.emailTemplate.body as string, lead, contact ?? undefined);

  // AI-personalized branch — when the step has useAI=true, call the Claude
  // outreach generator at send time so every recipient gets a bespoke draft
  // grounded in the workspace knowledge base. Template text is still used
  // as the "authored base" the generator reads as guidance. On failure,
  // fall back to the rendered template so a flaky LLM doesn't stall the
  // sequence.
  let subject = templateSubject;
  let body = templateBody;
  // Shape returned by `generateOutreachDraft` — kept loose because the
  // body is conditional on the LLM-provider response shape and may grow.
  let aiResult: { firstLine?: string; subject?: string; body?: string; reasoning?: string } | null = null;

  if (step.useAI) {
    try {
      // Resolve the original prospecting query that found this lead
      const prospectingJob = lead.jobId
        ? ((await ProspectingJobModel.findById(lead.jobId)
            .select('rawQuery')
            .lean()) as { rawQuery?: string } | null)
        : null;

      const leadFacts = lead.facts as Record<string, { value: unknown }> | undefined;

      aiResult = await generateOutreachDraft(
        {
          companyName:         lead.companyName as string | undefined,
          companyDomain:       lead.companyDomain as string | undefined,
          website:             lead.website as string | undefined,
          industry:            lead.industry as string | undefined,
          address:             lead.address as { city?: string; country?: string; state?: string } | undefined,
          socialProfiles:      lead.socialProfiles as { linkedinUrl?: string } | undefined,
          qualificationReason: lead.qualificationReason as string | undefined,
          agentReasoning:      lead.agentReasoning as string | undefined,
          prospectingQuery:    prospectingJob?.rawQuery as string | undefined,
          dynamicFields:       leadFacts
            ? Object.fromEntries(
                Object.entries(leadFacts)
                  .filter(([, v]) => v?.value != null)
                  .map(([k, v]) => [k, v.value]),
              )
            : undefined,
        },
        {
          name: (campaign?.name as string | undefined) ?? 'Workspace',
          settings: { cheapMode: true }, // sequence sends default to cheap mode — no per-send SERP research
          knowledgeBase: ((workspace.knowledgeBase ?? []) as Array<{ title: string; content: string; type?: string }>).map((kb) => ({
            title: kb.title,
            content: kb.content,
            type: kb.type,
          })),
        },
        {
          name: (campaign?.name as string | undefined) ?? 'Campaign',
          goal: (campaign?.description as string | undefined),
          outreachConfig: {
            channel: (step.channel as string | undefined) ?? 'email',
            tone: (step.tone as string | undefined) ?? (campaign?.outreachConfig?.tone as string | undefined) ?? 'direct',
            language: (campaign?.outreachConfig?.language as string | undefined) ?? 'English',
          },
        },
        (lead.rawSnippets as string[] | undefined) ?? [],
      );
      if (aiResult?.subject && aiResult?.body) {
        subject = aiResult.subject;
        body = aiResult.body;
        logger.info(`${tag} AI draft generated`, { subjectPreview: subject.slice(0, 80) });
      } else {
        logger.warn(`${tag} AI draft returned empty fields, falling back to template`);
        aiResult = null;
      }
    } catch (err) {
      logger.warn(`${tag} AI draft failed, falling back to template`, {
        err: err instanceof Error ? err.message : String(err),
      });
      aiResult = null;
    }
  }

  // Build unsubscribe URL
  const unsubscribeUrl = buildUnsubscribeUrl(enrollment.workspaceId.toString(), toEmail);

  // Send
  let messageId: string | null = null;
  let errorMessage: string | undefined;

  try {
    // Idempotency key: (enrollmentId, stepNumber) uniquely identifies this
    // send. A BullMQ retry of the same job re-uses this key so the provider
    // collapses the second delivery to the first message — preventing
    // double-send + double credit-charge on partial-success retries.
    const idempotencyKey = `seq:${String(enrollment._id)}:${stepNumber}`;
    messageId = await sendEmail(
      workspace.emailConfig,
      enrollment.workspaceId.toString(),
      toEmail,
      subject,
      body,
      unsubscribeUrl,
      idempotencyKey,
    );
    logger.info(`${tag} sent successfully`, { messageId, to: toEmail, idempotencyKey });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`${tag} send failed`, { err });
  }

  // Record step history
  const histEntry = {
    stepNumber,
    sentAt: messageId ? new Date() : undefined,
    status: messageId ? 'sent' : 'failed',
    messageId: messageId ?? undefined,
    errorMessage,
    toEmail,
  };

  await EnrollmentModel.updateOne({ _id: enrollmentId }, { $push: { stepHistory: histEntry } });

  // Persist an OutreachDraft row for AI-personalized sends so the audit
  // trail contains the exact model output. Template-rendered sends are
  // reproducible from the step definition and don't need this.
  if (messageId && aiResult && campaign?._id) {
    await OutreachDraftModel.create({
      workspaceId: enrollment.workspaceId,
      campaignId: campaign._id,
      leadId: enrollment.leadId,
      channel: (step.channel as string | undefined) ?? 'email',
      firstLine: aiResult.firstLine,
      subject,
      body,
      tone: (step.tone as string | undefined) ?? 'direct',
      language: (campaign.outreachConfig?.language as string | undefined) ?? 'English',
      reasoning: aiResult.reasoning,
      status: 'sent',
      sentAt: new Date(),
      deliveryMetadata: { provider: (workspace.emailConfig as { provider?: string }).provider, messageId },
    }).catch((err) => {
      logger.warn(`${tag} failed to persist OutreachDraft for AI send`, {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Update lead outreachStatus to 'sent' on first successful send
  if (messageId && stepNumber === 1) {
    await LeadModel.updateOne({ _id: enrollment.leadId }, { $set: { outreachStatus: 'sent' } });
  }

  // Bump campaign stats — feeds the detail page without per-request aggregation.
  if (messageId && campaign?._id) {
    await CampaignModel.updateOne(
      { _id: campaign._id },
      { $inc: { 'stats.sent': 1 } },
    ).catch((err) => logger.warn(`${tag} failed to $inc campaign stats.sent`, { err: err instanceof Error ? err.message : String(err) }));
  }

  if (messageId) {
    await advanceOrComplete(enrollment, sequence, step, new Date(), messageId);
  }
}

async function advanceOrComplete(
  enrollment: { _id: mongoose.Types.ObjectId },
  sequence: { steps: Array<{ stepNumber: number; delayDays?: number }> },
  currentStep: { stepNumber: number },
  sentAt: Date | null,
  _messageId: string | null,
): Promise<void> {
  const steps = sequence.steps;
  const nextStep = steps.find((s) => s.stepNumber === currentStep.stepNumber + 1);

  if (!nextStep) {
    await EnrollmentModel.updateOne(
      { _id: enrollment._id },
      { $set: { status: 'completed', completedAt: new Date() } },
    );
    return;
  }

  const base = sentAt ?? new Date();
  const nextStepAt = new Date(base.getTime() + (nextStep.delayDays ?? 0) * 86_400_000);

  await EnrollmentModel.updateOne(
    { _id: enrollment._id },
    { $set: { currentStep: nextStep.stepNumber, nextStepAt } },
  );
}

// ─── Worker factory ───────────────────────────────────────────────────────────
/**
 * `connection` is reserved for BullMQ (blocking-pop mode). `redis` is a
 * separate client used for side-channel operations — currently the daily
 * send-quota counter. They must be distinct ioredis instances.
 */
export function createSequenceWorker(connection: Redis, redis: Redis): Worker {
  if (mongoose.connection.readyState === 0) {
    mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME }).catch(err =>
      logger.error('Sequence worker Mongo connect error', { err }),
    );
  }

  const worker = new Worker<SequenceStepPayload>(
    'sequence-step',
    async (job) => {
      // Load just enough to establish the cost scope before the heavy path.
      // A missing enrollment is non-fatal — processSequenceStep re-checks and
      // returns early; we just fall through without a scope in that case.
      const enrollment = await EnrollmentModel.findById(job.data.enrollmentId)
        .select('workspaceId sequenceId')
        .lean();
      if (!enrollment?.workspaceId) {
        await processSequenceStep(job, redis);
        return;
      }
      // Campaign lookup for campaignId on the cost scope — strictly optional;
      // processSequenceStep does its own lookup later.
      const campaign = await CampaignModel.findOne({ sequenceId: enrollment.sequenceId ?? undefined })
        .select('_id').lean();
      const campaignId = campaign?._id ? String(campaign._id) : undefined;

      await runWithCostContext(
        { workspaceId: String(enrollment.workspaceId), campaignId },
        () => processSequenceStep(job, redis),
      );
    },
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      prefix: QUEUE_PREFIX,
    },
  );

  worker.on('completed', (job) => logger.info('sequence.worker: job completed', { jobId: job.id }));
  worker.on('failed', (job, err) => logger.error('sequence.worker: job failed', { jobId: job?.id, err }));

  return worker;
}
