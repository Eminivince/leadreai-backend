import type { SequenceStatus, EnrollmentStatus, StepStatus, EmailEventType, EmailProvider } from '../utils/constants.js';

export interface ISequenceStep {
  _id: string;
  stepNumber: number;
  channel: 'email' | 'linkedin' | 'sms';
  delayDays: number;
  sendWindow?: {
    startHour: number;
    endHour: number;
    timezone: string;
    allowedDays: number[];
  };
  emailTemplate?: {
    subject: string;
    body: string;
    fromName?: string;
    replyTo?: string;
  };
  useAI?: boolean;
  tone?: string;
  goal?: string;
}

export interface ISequenceStopRule {
  trigger: 'any_reply' | 'positive_reply' | 'unsubscribe' | 'bounce';
  action: 'stop_sequence' | 'pause_sequence';
}

export interface ISequenceStats {
  totalEnrolled: number;
  active: number;
  completed: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
}

export interface ISequence {
  _id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  description?: string;
  status: SequenceStatus;
  steps: ISequenceStep[];
  stopRules: ISequenceStopRule[];
  stats: ISequenceStats;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IStepHistoryEntry {
  stepNumber: number;
  sentAt?: string;
  deliveredAt?: string;
  openedAt?: string;
  clickedAt?: string;
  repliedAt?: string;
  bouncedAt?: string;
  bounceType?: 'hard' | 'soft';
  status: StepStatus;
  messageId?: string;
  errorMessage?: string;
  toEmail?: string;
}

export interface ISequenceEnrollment {
  _id: string;
  workspaceId: string;
  sequenceId: string;
  leadId: string;
  contactId?: string;
  enrolledBy: string;
  status: EnrollmentStatus;
  currentStep: number;
  nextStepAt?: string;
  completedAt?: string;
  stopReason?: string;
  stepHistory: IStepHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface IEmailEvent {
  _id: string;
  workspaceId: string;
  enrollmentId?: string;
  messageId: string;
  event: EmailEventType;
  provider: EmailProvider;
  bounceType?: 'hard' | 'soft';
  occurredAt: string;
  processedAt: string;
}
