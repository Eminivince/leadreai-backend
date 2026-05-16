import mongoose, { Types } from 'mongoose';
import type {
  CreateCampaignInput,
  CampaignStepInput,
  CampaignSchedule,
  CampaignReplyRules,
} from '../../shared/index.js';
import { nextSendTime } from '../../shared/index.js';
import Lead from '../models/Lead.js';
import File from '../models/File.js';
import Workspace from '../models/Workspace.js';
import SequenceEnrollment from '../models/SequenceEnrollment.js';
import { SuppressionEntry } from '../models/SuppressionList.js';
import type { ICampaign } from '../models/Campaign.js';
import type { ISequenceDoc } from '../models/Sequence.js';
import { preflightEmailProvider } from './email/preflight.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

/**
 * Pure transform from the wizard's create-campaign payload into the input
 * shape expected by `Sequence.create`. No DB access, no side-effects — so
 * this is trivially unit-testable and can be exercised by both the
 * wizard-create path and any future import/clone path.
 */
export function buildSequenceFromPayload(params: {
  workspaceId: Types.ObjectId;
  createdBy: Types.ObjectId;
  payload: CreateCampaignInput;
}): SequenceCreateInput {
  const { workspaceId, createdBy, payload } = params;
  const sendWindow = toSendWindow(payload.schedule);
  const stopRules = toStopRules(payload.replyRules);

  return {
    workspaceId,
    createdBy,
    name: payload.name,
    description: payload.description,
    status: 'draft',
    steps: payload.steps.map((step, i) => buildStep(step, i, sendWindow)),
    stopRules,
    tags: [],
  };
}

// ── Preflight ----------------------------------------------------------

export interface PreflightResult {
  totalInFile: number;
  eligibleLeadsCount: number;
  skipped: {
    noEmail: number;
    suppressed: number;
    filtered: number; // audience filter rejections
    alreadyEnrolled: number;
  };
  hasEmailConfig: boolean;
  firstSendAt: Date | null;
}

/**
 * Computes what would happen if the campaign were activated right now.
 * Pure read — no state changes. Used for the preflight endpoint so the
 * UI can show "N of M leads will be enrolled" before confirmation.
 */
export async function computePreflight(params: {
  workspaceId: Types.ObjectId;
  campaign: ICampaign;
  sequence: ISequenceDoc;
}): Promise<PreflightResult> {
  const { workspaceId, campaign, sequence } = params;

  const [file, workspace, suppression] = await Promise.all([
    File.findOne({ _id: campaign.fileId, workspaceId }).lean(),
    Workspace.findById(workspaceId).select('emailConfig.provider emailConfig.fromEmail').lean(),
    loadSuppression(workspaceId),
  ]);

  const fileLeadIds = file?.leadIds ?? [];
  const totalInFile = fileLeadIds.length;

  if (totalInFile === 0) {
    return {
      totalInFile: 0,
      eligibleLeadsCount: 0,
      skipped: { noEmail: 0, suppressed: 0, filtered: 0, alreadyEnrolled: 0 },
      hasEmailConfig: Boolean(workspace?.emailConfig?.fromEmail),
      firstSendAt: null,
    };
  }

  const leads = await Lead.find({ _id: { $in: fileLeadIds }, workspaceId })
    .select('emails rankScore')
    .lean();

  let noEmail = 0;
  let suppressed = 0;
  let filtered = 0;
  const enrollableLeadIds: Types.ObjectId[] = [];

  for (const lead of leads) {
    if (!passesAudienceFilter(lead, campaign)) {
      filtered++;
      continue;
    }
    const primary = pickPrimaryEmail(lead, campaign);
    if (!primary) {
      noEmail++;
      continue;
    }
    if (suppression.has(primary, primary.split('@')[1] ?? '')) {
      suppressed++;
      continue;
    }
    enrollableLeadIds.push(lead._id);
  }

  // Exclude leads already enrolled in THIS sequence (idempotent activation).
  const alreadyEnrolled = await SequenceEnrollment.countDocuments({
    sequenceId: sequence._id,
    leadId: { $in: enrollableLeadIds },
  });

  return {
    totalInFile,
    eligibleLeadsCount: enrollableLeadIds.length - alreadyEnrolled,
    skipped: { noEmail, suppressed, filtered, alreadyEnrolled },
    hasEmailConfig: Boolean(workspace?.emailConfig?.fromEmail),
    firstSendAt: firstSendTimeFor(campaign, sequence),
  };
}

// ── Activate -----------------------------------------------------------

export interface ActivateResult {
  enrolled: number;
  skipped: number;
  firstSendAt: Date | null;
}

/**
 * Flips Campaign.status + Sequence.status to 'active' and bulk-creates
 * SequenceEnrollment rows for every eligible lead in the file. Idempotent:
 * the unique (sequenceId, leadId) index silently skips duplicates when
 * `ordered: false` is passed to insertMany.
 */
export async function activateCampaign(params: {
  workspaceId: Types.ObjectId;
  enrolledBy: Types.ObjectId;
  campaign: ICampaign;
  sequence: ISequenceDoc;
}): Promise<ActivateResult> {
  const { workspaceId, enrolledBy, campaign, sequence } = params;

  // Credential preflight — verify the workspace email provider actually
  // accepts our key before we enroll anyone. The pre-fix flow let
  // activation succeed with stale credentials; users would see "Campaign
  // active" then 0 sends until the next manual reconnect. Now we fail
  // loud at activation, surface the provider's reason, and let the user
  // fix the credential first.
  const wsForPreflight = await Workspace.findById(workspaceId)
    .select('+emailConfig.apiKey +emailConfig.smtpPass +emailConfig.gmail.refreshToken +emailConfig.gmail.accessToken')
    .lean();
  if (!wsForPreflight?.emailConfig) {
    throw ApiError.badRequest('Workspace has no email config — connect a sender before activating.');
  }
  const preflight = await preflightEmailProvider(wsForPreflight.emailConfig);
  if (!preflight.ok) {
    logger.warn('[activateCampaign] email preflight failed — refusing activation', {
      workspaceId: String(workspaceId),
      campaignId: String(campaign._id),
      provider: preflight.provider,
      reason: preflight.reason,
    });
    throw ApiError.badRequest(
      `Email provider preflight failed (${preflight.provider}): ${preflight.reason ?? 'unknown error'}. Reconnect the sender and try again.`,
    );
  }

  const [file, suppression] = await Promise.all([
    File.findOne({ _id: campaign.fileId, workspaceId }).lean(),
    loadSuppression(workspaceId),
  ]);

  const fileLeadIds = file?.leadIds ?? [];
  if (fileLeadIds.length === 0) {
    return { enrolled: 0, skipped: 0, firstSendAt: null };
  }

  const leads = await Lead.find({ _id: { $in: fileLeadIds }, workspaceId })
    .select('emails rankScore')
    .lean();

  const firstSendAt = firstSendTimeFor(campaign, sequence);

  const enrollments = leads
    .filter((l) => {
      if (!passesAudienceFilter(l, campaign)) return false;
      const email = pickPrimaryEmail(l, campaign);
      if (!email) return false;
      if (suppression.has(email, email.split('@')[1] ?? '')) return false;
      return true;
    })
    .map((l) => ({
      workspaceId,
      sequenceId: sequence._id,
      leadId: l._id,
      enrolledBy,
      status: 'active' as const,
      currentStep: 1,
      nextStepAt: firstSendAt,
      stepHistory: [],
    }));

  let enrolled = 0;
  if (enrollments.length > 0) {
    try {
      const inserted = await SequenceEnrollment.insertMany(enrollments, { ordered: false });
      enrolled = inserted.length;
    } catch (err) {
      // Duplicate key errors on the `(sequenceId, leadId)` unique index are
      // expected when re-activating. `insertMany` with `ordered: false`
      // still inserts non-conflicting rows and throws BulkWriteError with
      // `result.insertedCount` populated.
      const bulkErr = err as { writeErrors?: unknown[]; result?: { insertedCount?: number }; insertedDocs?: unknown[] };
      enrolled = bulkErr.insertedDocs?.length ?? bulkErr.result?.insertedCount ?? 0;
      // Re-throw if it's not a duplicate-key issue.
      const allDupes = (bulkErr.writeErrors ?? []).every(
        (e) => (e as { code?: number }).code === 11000,
      );
      if (!allDupes && (bulkErr.writeErrors?.length ?? 0) > 0) throw err;
    }
  }

  const skipped = leads.length - enrollments.length;

  // Flip statuses to 'active' — idempotent.
  await Promise.all([
    sequence.status !== 'active'
      ? sequence.updateOne({ status: 'active' })
      : Promise.resolve(),
    campaign.status !== 'active'
      ? mongoose.model('Campaign').updateOne({ _id: campaign._id }, { status: 'active' })
      : Promise.resolve(),
  ]);

  return { enrolled, skipped, firstSendAt };
}

// ── Stats + pause/resume ---------------------------------------------

export interface CampaignStatsResult {
  enrollments: {
    active: number;
    paused: number;
    completed: number;
    stopped: number;
    bounced: number;
    unsubscribed: number;
    replied: number;
    total: number;
  };
  perStep: Array<{ stepNumber: number; sent: number; bounced: number; replied: number }>;
  campaignStats: {
    totalLeads: number;
    draftsCreated: number;
    sent: number;
    opened: number;
    replied: number;
    bounced: number;
  };
  /** Reply classification breakdown (Task #16/26 frontend). Counts
   *  EmailEvent rows for this campaign's enrollments. Sums may differ
   *  from `enrollments.replied` because one enrollment can have
   *  multiple inbound events (follow-up replies). */
  replyClassification: {
    positive: number;
    ooo: number;
    bounce: number;
    unknown: number;
  };
}

/**
 * One-shot analytics summary. Aggregates enrollment-status counts and
 * per-step counts from stepHistory in a single query each, so a campaign
 * with thousands of enrollments still responds quickly. The campaign's
 * denormalized `stats` object is returned alongside for `sent` — it's
 * $inc'd by the worker and is the fastest read for dashboards.
 */
export async function computeCampaignStats(params: {
  workspaceId: Types.ObjectId;
  campaign: ICampaign;
  sequence: ISequenceDoc;
}): Promise<CampaignStatsResult> {
  const { workspaceId, campaign, sequence } = params;

  const [statusAgg, stepAgg] = await Promise.all([
    SequenceEnrollment.aggregate<{ _id: string; count: number }>([
      { $match: { workspaceId, sequenceId: sequence._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    SequenceEnrollment.aggregate<{ _id: number; status: string; count: number }>([
      { $match: { workspaceId, sequenceId: sequence._id } },
      { $unwind: '$stepHistory' },
      {
        $group: {
          _id: { stepNumber: '$stepHistory.stepNumber', status: '$stepHistory.status' },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: '$_id.stepNumber', status: '$_id.status', count: 1 } },
    ]),
  ]);

  const enrollments = {
    active: 0,
    paused: 0,
    completed: 0,
    stopped: 0,
    bounced: 0,
    unsubscribed: 0,
    replied: 0,
    total: 0,
  };
  for (const row of statusAgg) {
    const key = row._id as keyof typeof enrollments;
    if (key in enrollments) enrollments[key] = row.count;
    enrollments.total += row.count;
  }

  const perStepMap = new Map<number, { stepNumber: number; sent: number; bounced: number; replied: number }>();
  for (const step of sequence.steps) {
    perStepMap.set(step.stepNumber, { stepNumber: step.stepNumber, sent: 0, bounced: 0, replied: 0 });
  }
  for (const row of stepAgg) {
    const entry = perStepMap.get(row._id) ?? { stepNumber: row._id, sent: 0, bounced: 0, replied: 0 };
    if (row.status === 'sent' || row.status === 'delivered' || row.status === 'opened' || row.status === 'clicked') {
      entry.sent += row.count;
    } else if (row.status === 'bounced') {
      entry.bounced += row.count;
    } else if (row.status === 'replied') {
      entry.replied += row.count;
    }
    perStepMap.set(row._id, entry);
  }

  // Reply classification breakdown — aggregate from EmailEvent for
  // this campaign's enrollment set. One Mongo aggregation, no extra
  // round-trips per enrollment.
  const { default: EmailEvent } = await import('../models/EmailEvent.js');
  const replyClass: { positive: number; ooo: number; bounce: number; unknown: number } = {
    positive: 0, ooo: 0, bounce: 0, unknown: 0,
  };
  try {
    const enrollmentIds = await SequenceEnrollment.find({
      workspaceId,
      sequenceId: sequence._id,
    }).distinct('_id');
    if (enrollmentIds.length > 0) {
      const rows = await EmailEvent.aggregate<{ _id: string | null; count: number }>([
        { $match: { workspaceId, enrollmentId: { $in: enrollmentIds }, event: 'replied' } },
        { $group: { _id: '$classification', count: { $sum: 1 } } },
      ]);
      for (const row of rows) {
        const key = row._id as keyof typeof replyClass | null;
        if (key && key in replyClass) replyClass[key] = row.count;
        else replyClass.unknown += row.count;
      }
    }
  } catch {
    // Classification is opportunistic — never fail the stats call.
  }

  return {
    enrollments,
    perStep: Array.from(perStepMap.values()).sort((a, b) => a.stepNumber - b.stepNumber),
    campaignStats: {
      totalLeads: campaign.stats.totalLeads,
      draftsCreated: campaign.stats.draftsCreated,
      sent: campaign.stats.sent,
      opened: campaign.stats.opened,
      replied: campaign.stats.replied,
      bounced: campaign.stats.bounced,
    },
    replyClassification: replyClass,
  };
}

/**
 * Pause: flip Campaign + Sequence + eligible enrollments. Enrollments
 * keep a `stopReason: 'campaign_paused'` so resume only re-activates
 * the ones we paused here — not ones that were paused for other reasons
 * (e.g. per-lead pause-on-reply in M4).
 */
export async function pauseCampaign(params: {
  workspaceId: Types.ObjectId;
  campaign: ICampaign;
  sequence: ISequenceDoc;
}): Promise<{ pausedEnrollments: number }> {
  const { workspaceId, campaign, sequence } = params;

  const result = await SequenceEnrollment.updateMany(
    { workspaceId, sequenceId: sequence._id, status: 'active' },
    { $set: { status: 'paused', stopReason: 'campaign_paused' } },
  );

  await Promise.all([
    mongoose.model('Campaign').updateOne({ _id: campaign._id }, { status: 'paused' }),
    sequence.updateOne({ status: 'paused' }),
  ]);

  return { pausedEnrollments: result.modifiedCount ?? 0 };
}

/**
 * Resume: flip back. Only re-activates enrollments that were paused
 * with `stopReason: 'campaign_paused'` so per-lead pauses survive.
 */
export async function resumeCampaign(params: {
  workspaceId: Types.ObjectId;
  campaign: ICampaign;
  sequence: ISequenceDoc;
}): Promise<{ resumedEnrollments: number }> {
  const { workspaceId, campaign, sequence } = params;

  const result = await SequenceEnrollment.updateMany(
    { workspaceId, sequenceId: sequence._id, status: 'paused', stopReason: 'campaign_paused' },
    { $set: { status: 'active' }, $unset: { stopReason: '' } },
  );

  await Promise.all([
    mongoose.model('Campaign').updateOne({ _id: campaign._id }, { status: 'active' }),
    sequence.updateOne({ status: 'active' }),
  ]);

  return { resumedEnrollments: result.modifiedCount ?? 0 };
}

// ── Helpers ------------------------------------------------------------

interface Suppression {
  has(email: string, domain: string): boolean;
}

async function loadSuppression(workspaceId: Types.ObjectId): Promise<Suppression> {
  const entries = await SuppressionEntry.find({ workspaceId }).select('email domain').lean();
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const e of entries) {
    if (e.email) emails.add(e.email.toLowerCase());
    if (e.domain) domains.add(e.domain.toLowerCase());
  }
  return {
    has(email, domain) {
      return emails.has(email.toLowerCase()) || domains.has(domain.toLowerCase());
    },
  };
}

function passesAudienceFilter(
  lead: { rankScore?: number; emails?: Array<{ verified?: boolean }> },
  campaign: ICampaign,
): boolean {
  const f = campaign.audienceFilters;
  if (!f) return true;
  if (f.hotOnly && (lead.rankScore ?? 0) < 90) return false;
  if (f.verifiedOnly && !(lead.emails ?? []).some((e) => e.verified)) return false;
  return true;
}

function pickPrimaryEmail(
  lead: { emails?: Array<{ address: string; type?: string; verified?: boolean; confidence?: number }> },
  campaign: ICampaign,
): string | null {
  const emails = lead.emails ?? [];
  if (emails.length === 0) return null;
  const verifiedOnly = campaign.audienceFilters?.verifiedOnly ?? false;
  const candidates = verifiedOnly ? emails.filter((e) => e.verified) : emails;
  if (candidates.length === 0) return null;
  // Prefer business-type, then highest confidence, then first.
  const sorted = [...candidates].sort((a, b) => {
    const businessRank = (e: typeof a) => (e.type === 'business' ? 1 : 0);
    return (businessRank(b) - businessRank(a)) || ((b.confidence ?? 0) - (a.confidence ?? 0));
  });
  return sorted[0]?.address ?? null;
}

function firstSendTimeFor(campaign: ICampaign, sequence: ISequenceDoc): Date {
  const step = sequence.steps[0];
  const delayDays = step?.delayDays ?? 0;
  const baseline = new Date(Date.now() + delayDays * 86_400_000);
  const sw = step?.sendWindow ?? (campaign.schedule
    ? {
      startHour: campaign.schedule.startHour,
      endHour: campaign.schedule.endHour,
      timezone: campaign.schedule.timezone,
      allowedDays: campaign.schedule.allowedDays,
    }
    : null);
  return sw ? nextSendTime(sw, baseline) : baseline;
}

// ── Internal types mirroring Sequence Mongoose shape -------------------

interface SequenceSendWindow {
  timezone: string;
  startHour: number;
  endHour: number;
  allowedDays: number[];
}

interface SequenceStepInput {
  stepNumber: number;
  channel: 'email' | 'linkedin' | 'sms';
  delayDays: number;
  sendWindow: SequenceSendWindow;
  emailTemplate: { subject: string; body: string };
  useAI: boolean;
  tone: string;
  goal: string;
}

interface SequenceStopRule {
  trigger: 'any_reply' | 'positive_reply' | 'unsubscribe' | 'bounce';
  action: 'stop_sequence' | 'pause_sequence';
}

export interface SequenceCreateInput {
  workspaceId: Types.ObjectId;
  createdBy: Types.ObjectId;
  name: string;
  description?: string;
  status: 'draft';
  steps: SequenceStepInput[];
  stopRules: SequenceStopRule[];
  tags: string[];
}

function buildStep(
  step: CampaignStepInput,
  index: number,
  sendWindow: SequenceSendWindow,
): SequenceStepInput {
  return {
    stepNumber: index + 1,
    channel: step.channel,
    delayDays: step.delayDays,
    sendWindow,
    emailTemplate: {
      subject: step.subject,
      body: step.body,
    },
    useAI: step.useAI,
    tone: step.tone,
    goal: step.goal,
  };
}

function toSendWindow(schedule: CampaignSchedule): SequenceSendWindow {
  return {
    timezone: schedule.timezone,
    startHour: schedule.startHour,
    endHour: schedule.endHour,
    allowedDays: schedule.allowedDays,
  };
}

function toStopRules(rules: CampaignReplyRules): SequenceStopRule[] {
  const baseline: SequenceStopRule[] = [
    { trigger: 'unsubscribe', action: 'stop_sequence' },
    { trigger: 'bounce', action: 'stop_sequence' },
  ];
  if (rules.pauseOnReply) {
    baseline.push({ trigger: 'any_reply', action: 'pause_sequence' });
  }
  return baseline;
}
