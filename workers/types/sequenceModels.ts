import type { Types } from 'mongoose';

/**
 * Lean Mongoose document shapes consumed by sequence.worker.ts.
 *
 * These mirror only the fields the worker actually reads — the upstream
 * models in `backend/src/models/` carry more, but importing them here
 * would couple the workers package to backend internals. Mongoose
 * schemas in sequence.worker.ts use `strict: false`, which gives us
 * runtime flexibility; these interfaces add compile-time safety on top.
 */

export interface EmailConfigGmail {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  email?: string;
}

export interface EmailConfig {
  provider?: 'gmail' | 'resend' | 'sendgrid' | 'smtp' | string;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  apiKey?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  gmail?: EmailConfigGmail;
}

export interface IWorkspaceSeq {
  _id: Types.ObjectId;
  emailConfig?: EmailConfig;
  knowledgeBase?: Array<{ title: string; content: string; type?: string }>;
  name?: string;
}

export interface ILeadEmailEntry {
  address?: string;
  type?: string;
}

export interface ILeadSeq {
  _id: Types.ObjectId;
  jobId?: Types.ObjectId;
  companyName?: string;
  companyDomain?: string;
  industry?: string;
  website?: string;
  address?: { city?: string; country?: string; state?: string };
  emails?: ILeadEmailEntry[];
  qualificationReason?: string;
  agentReasoning?: string;
  socialProfiles?: { linkedinUrl?: string };
  facts?: Record<string, { value: unknown }>;
  rawSnippets?: string[];
}

export interface IContactSeq {
  _id: Types.ObjectId;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  title?: string;
}

export interface IStepHistoryEntry {
  stepNumber: number;
  sentAt?: Date;
  status: string;
  messageId?: string;
  errorMessage?: string;
  toEmail?: string;
}

export interface IEnrollmentSeq {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  sequenceId: Types.ObjectId;
  leadId: Types.ObjectId;
  contactId?: Types.ObjectId;
  status?: string;
  currentStep: number;
  nextStepAt?: Date;
  completedAt?: Date;
  stopReason?: string;
  stepHistory?: IStepHistoryEntry[];
}

export interface ISequenceStep {
  stepNumber: number;
  channel?: string;
  delayDays?: number;
  sendWindow?: unknown;
  emailTemplate?: { subject?: string; body?: string; useAI?: boolean; tone?: string; [k: string]: unknown };
  useAI?: boolean;
  tone?: string;
}

export interface ISequenceSeq {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  status?: string;
  steps: ISequenceStep[];
  stopRules?: Array<{ trigger: string; action: string }>;
}

export interface ISuppressionSeq {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  email?: string;
  domain?: string;
}

export interface IProspectingJobSeq {
  _id: Types.ObjectId;
  rawQuery?: string;
}

export interface ICampaignSchedule {
  timezone?: string;
  startHour?: number;
  endHour?: number;
  allowedDays?: number[];
  dailySendCap?: number;
}

export interface ICampaignSeq {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  sequenceId?: Types.ObjectId;
  name?: string;
  description?: string;
  outreachConfig?: { channel?: string; tone?: string; language?: string };
  schedule?: ICampaignSchedule;
}

export interface IOutreachDraftSeq {
  _id?: Types.ObjectId;
  workspaceId: Types.ObjectId;
  campaignId?: Types.ObjectId;
  leadId: Types.ObjectId;
  createdBy?: Types.ObjectId;
  channel?: string;
  firstLine?: string;
  subject?: string;
  body?: string;
  tone?: string;
  language?: string;
  reasoning?: string;
  status?: string;
  sentAt?: Date;
  deliveryMetadata?: { provider?: string; messageId?: string };
}
