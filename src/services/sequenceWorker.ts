/**
 * Sequence worker (M2) — polls for due enrollments and fires emails.
 *
 * Every 30 seconds:
 *   1. Find SequenceEnrollments where status='active' AND nextStepAt <= now (batch of 20)
 *   2. Atomically claim each one (advance nextStepAt by 10 min to prevent double-processing)
 *   3. Render email: AI draft (useAI=true) or static template
 *   4. Send via workspace email config (Gmail / Resend / SendGrid / SMTP)
 *   5. Advance to next step or mark completed
 *
 * On send failure: retries in 30 min, records error in stepHistory.
 */

import SequenceEnrollment, { type ISequenceEnrollmentDoc } from '../models/SequenceEnrollment.js';
import Sequence from '../models/Sequence.js';
import Lead from '../models/Lead.js';
import ProspectingJob from '../models/ProspectingJob.js';
import Workspace from '../models/Workspace.js';
import { Contact } from '../models/Contact.js';
import { sendEmailForWorkspace, textToHtml } from './email/emailService.js';
import { generateOutreachDraft } from './ai/outreachDraftService.js';
import { buildUnsubscribeUrl } from './unsubscribe.js';
import { logger } from '../utils/logger.js';
import type { IEmailConfig } from '../models/Workspace.js';

const TICK_MS = 30_000;
const BATCH_SIZE = 20;
const CLAIM_WINDOW_MS = 10 * 60_000;  // 10 min lock on claimed enrollments
const RETRY_DELAY_MS  = 30 * 60_000;  // retry failed sends after 30 min

let _timer: ReturnType<typeof setInterval> | null = null;

// ── Template variable substitution ──────────────────────────────────────────

function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? '');
}

// ── Core: process one due enrollment ────────────────────────────────────────

async function processEnrollment(enrollmentId: string): Promise<void> {
  const tag = `[seqWorker:${enrollmentId}]`;
  const now = new Date();

  // Atomically claim: prevents double-send if tick overlaps
  const enrollment = await SequenceEnrollment.findOneAndUpdate(
    { _id: enrollmentId, status: 'active', nextStepAt: { $lte: now } },
    { $set: { nextStepAt: new Date(now.getTime() + CLAIM_WINDOW_MS) } },
    { new: false },
  );
  if (!enrollment) {
    return; // another tick already claimed it
  }

  // ── Load sequence ──────────────────────────────────────────────────────────
  const sequence = await Sequence.findById(enrollment.sequenceId).lean();
  if (!sequence) {
    logger.warn(`${tag} sequence not found — stopping`);
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId },
      { $set: { status: 'stopped', stopReason: 'sequence_deleted' } },
    );
    return;
  }

  const stepIndex = enrollment.currentStep - 1;
  const step = sequence.steps[stepIndex];

  if (!step) {
    // currentStep > totalSteps → all steps already fired, mark complete
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId },
      { $set: { status: 'completed', completedAt: now, nextStepAt: undefined } },
    );
    await Sequence.updateOne(
      { _id: enrollment.sequenceId },
      { $inc: { 'stats.completed': 1, 'stats.active': -1 } },
    );
    return;
  }

  // ── Load lead ──────────────────────────────────────────────────────────────
  const lead = await Lead.findById(enrollment.leadId).lean();
  if (!lead) {
    logger.warn(`${tag} lead not found — stopping`);
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId },
      { $set: { status: 'stopped', stopReason: 'lead_deleted' } },
    );
    return;
  }
  const toEmail = lead.emails?.[0]?.address;
  if (!toEmail) {
    logger.warn(`${tag} lead has no email — stopping`);
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId },
      { $set: { status: 'stopped', stopReason: 'no_email' } },
    );
    return;
  }

  // ── Load workspace email config ────────────────────────────────────────────
  const workspace = await Workspace.findById(enrollment.workspaceId)
    .select('+emailConfig.apiKey +emailConfig.smtpPass +emailConfig.gmail.accessToken +emailConfig.gmail.refreshToken')
    .lean();
  if (!workspace?.emailConfig) {
    logger.warn(`${tag} workspace has no email config — stopping`);
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId },
      { $set: { status: 'stopped', stopReason: 'no_email_config' } },
    );
    return;
  }

  // ── Build template variables ───────────────────────────────────────────────
  let firstName = '';
  let lastName = '';
  if (enrollment.contactId) {
    const contact = await Contact.findById(enrollment.contactId).lean();
    if (contact) {
      firstName = contact.firstName ?? contact.fullName?.split(' ')[0] ?? '';
      lastName  = contact.lastName  ?? contact.fullName?.split(' ').slice(1).join(' ') ?? '';
    }
  }
  if (!firstName) {
    // Derive from lead or email local-part
    firstName = lead.companyName?.split(' ')[0] ?? toEmail.split('@')[0] ?? '';
  }
  const vars: Record<string, string> = {
    first_name:   firstName,
    last_name:    lastName,
    company_name: lead.companyName ?? '',
    website:      lead.website ?? lead.companyDomain ?? '',
    city:         lead.address?.city ?? '',
    industry:     lead.industry ?? '',
  };

  // ── Render email ───────────────────────────────────────────────────────────
  let subject: string;
  let bodyHtml: string;

  if (step.useAI) {
    try {
      // Resolve the original prospecting query that found this lead
      const prospectingJob = lead.jobId
        ? await ProspectingJob.findById(lead.jobId).select('rawQuery').lean()
        : null;

      const draft = await generateOutreachDraft(
        {
          companyName:         lead.companyName,
          companyDomain:       lead.companyDomain,
          website:             lead.website,
          industry:            lead.industry,
          address:             lead.address,
          socialProfiles:      lead.socialProfiles,
          qualificationReason: lead.qualificationReason,
          agentReasoning:      lead.agentReasoning,
          prospectingQuery:    prospectingJob?.rawQuery,
          dynamicFields:       lead.facts
            ? Object.fromEntries(
                Object.entries(lead.facts)
                  .filter(([, v]) => v?.value != null)
                  .map(([k, v]) => [k, v.value]),
              )
            : undefined,
        },
        {
          name:          workspace.name,
          settings:      workspace.settings ? { cheapMode: workspace.settings.cheapMode } : undefined,
          knowledgeBase: workspace.knowledgeBase,
        },
        {
          name:           sequence.name,
          goal:           sequence.description,
          outreachConfig: { tone: step.tone ?? 'professional', channel: 'email' },
        },
        lead.rawSnippets ?? [],
      );
      subject  = draft.subject;
      bodyHtml = textToHtml(draft.body);
    } catch (err) {
      logger.error(`${tag} AI draft failed`, { err });
      // Fall back to template if available; otherwise retry later
      if (!step.emailTemplate?.subject) {
        logger.warn(`${tag} no template fallback — retrying in 30 min`);
        await SequenceEnrollment.updateOne(
          { _id: enrollmentId },
          { $set: { nextStepAt: new Date(now.getTime() + RETRY_DELAY_MS) } },
        );
        return;
      }
      subject  = render(step.emailTemplate.subject, vars);
      bodyHtml = textToHtml(render(step.emailTemplate.body ?? '', vars));
    }
  } else {
    if (!step.emailTemplate?.subject) {
      // Step has no content — skip it and move on
      logger.warn(`${tag} step ${enrollment.currentStep} has no template — skipping`);
      await advance(enrollmentId, enrollment, sequence.steps.length, sequence.steps[stepIndex + 1]?.delayDays ?? 1);
      return;
    }
    subject  = render(step.emailTemplate.subject, vars);
    bodyHtml = textToHtml(render(step.emailTemplate.body ?? '', vars));
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  const unsubscribeUrl = buildUnsubscribeUrl(enrollment.workspaceId.toString(), toEmail);
  let messageId: string;
  try {
    const result = await sendEmailForWorkspace(workspace.emailConfig as IEmailConfig, {
      to:             toEmail,
      subject,
      html:           bodyHtml,
      unsubscribeUrl,
      workspaceId:    enrollment.workspaceId.toString(),
    });
    messageId = result.messageId;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`${tag} send failed — retrying in 30 min`, { errorMessage });
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId },
      {
        $push: {
          stepHistory: {
            stepNumber:   enrollment.currentStep,
            status:       'failed',
            errorMessage,
            toEmail,
          },
        },
        $set: { nextStepAt: new Date(now.getTime() + RETRY_DELAY_MS) },
      },
    );
    return;
  }

  // ── Record sent + advance ──────────────────────────────────────────────────
  await SequenceEnrollment.updateOne(
    { _id: enrollmentId },
    {
      $push: {
        stepHistory: {
          stepNumber: enrollment.currentStep,
          sentAt:     now,
          status:     'sent',
          messageId,
          toEmail,
        },
      },
    },
  );
  await Sequence.updateOne(
    { _id: enrollment.sequenceId },
    { $inc: { 'stats.replied': 0 } }, // keep stats consistent; sent increments via campaign stats
  );

  const nextDelayDays = sequence.steps[stepIndex + 1]?.delayDays ?? 1;
  await advance(enrollmentId, enrollment, sequence.steps.length, nextDelayDays);
  logger.info(`${tag} step ${enrollment.currentStep} → ${toEmail} (msgId: ${messageId})`);
}

// ── Advance to next step or mark completed ───────────────────────────────────

async function advance(
  enrollmentId: string,
  enrollment: ISequenceEnrollmentDoc,
  totalSteps: number,
  nextDelayDays: number,
): Promise<void> {
  const nextStep = enrollment.currentStep + 1;
  if (nextStep > totalSteps) {
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId },
      {
        $set: {
          status:      'completed',
          completedAt: new Date(),
          nextStepAt:  undefined,
          currentStep: nextStep,
        },
      },
    );
    await Sequence.updateOne(
      { _id: enrollment.sequenceId },
      { $inc: { 'stats.completed': 1, 'stats.active': -1 } },
    );
  } else {
    const nextAt = new Date(Date.now() + nextDelayDays * 86_400_000);
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId },
      { $set: { currentStep: nextStep, nextStepAt: nextAt } },
    );
  }
}

// ── Tick: find and process all due enrollments ───────────────────────────────

async function tick(): Promise<void> {
  try {
    const due = await SequenceEnrollment.find(
      { status: 'active', nextStepAt: { $lte: new Date() } },
      { _id: 1 },
    ).limit(BATCH_SIZE).lean();

    if (due.length === 0) return;
    logger.info(`[seqWorker] ${due.length} due enrollment(s) — processing`);

    for (const { _id } of due) {
      try {
        await processEnrollment(_id.toString());
      } catch (err) {
        logger.error(`[seqWorker] unexpected error for ${_id}`, { err });
      }
    }
  } catch (err) {
    logger.error('[seqWorker] tick failed', { err });
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function startSequenceWorker(): void {
  if (_timer) return;
  void tick(); // fire immediately on boot
  _timer = setInterval(() => { void tick(); }, TICK_MS);
  logger.info('[seqWorker] started (30 s interval)');
}

export function stopSequenceWorker(): void {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
  logger.info('[seqWorker] stopped');
}
