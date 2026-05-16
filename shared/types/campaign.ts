import { OUTREACH_CHANNELS } from '../utils/constants.js';
import type { KnowledgeBaseEntryType } from '../utils/constants.js';
import type {
  CampaignStepInput,
  CampaignSchedule,
  CampaignAudienceFilters,
  CampaignReplyRules,
} from '../schemas/zod/campaign.schemas.js';

export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export interface KnowledgeBaseEntry {
  _id: string;
  title: string;
  content: string;
  type: KnowledgeBaseEntryType;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachDraft {
  _id: string;
  workspaceId: string;
  campaignId: string;
  leadId: string;
  createdBy: string;
  channel: OutreachChannel;
  deliveryMetadata?: { provider?: string; messageId?: string; threadId?: string; };
  firstLine?: string;
  subject?: string;
  body: string;
  tone: string;
  language: string;
  version: number;
  status: 'draft' | 'approved' | 'sent' | 'failed';
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Legacy campaign-wide outreach config. Still populated on new campaigns
 * (first step's tone/language) as a compat shim for the bulk-draft worker
 * that predates per-step tone.
 */
export interface OutreachConfig {
  channel: OutreachChannel;
  tone: string;
  language: string;
  personalization: string[];
  systemPromptOverride?: string;
}

export interface CampaignStats {
  totalLeads: number;
  draftsCreated: number;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
}

export interface Campaign {
  _id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  description?: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  fileId: string;

  // Sequence link — set on create when the wizard builds a multi-step
  // campaign. Null only for legacy single-draft campaigns.
  sequenceId?: string;

  // Wizard-era fields. `schedule.dailySendCap` is the canonical cap.
  audienceFilters?: CampaignAudienceFilters;
  replyRules?: CampaignReplyRules;
  schedule?: CampaignSchedule;

  // Legacy — see OutreachConfig JSDoc.
  outreachConfig: OutreachConfig;

  stats: CampaignStats;
  createdAt: string;
  updatedAt: string;
}

// Re-export wizard payload types so frontend/backend share one import path.
export type {
  CampaignStepInput,
  CampaignSchedule,
  CampaignAudienceFilters,
  CampaignReplyRules,
};
