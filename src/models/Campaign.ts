import mongoose, { Schema } from 'mongoose';
import { OUTREACH_CHANNELS } from '../../shared/index.js';

const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'] as const;

export interface ICampaignAudienceFilters {
  hotOnly: boolean;
  verifiedOnly: boolean;
}

export interface ICampaignReplyRules {
  pauseOnReply: boolean;
  classify: boolean;
  notifyChannel: 'slack' | 'email' | 'none';
}

export interface ICampaignSchedule {
  timezone: string;
  startHour: number;
  endHour: number;
  allowedDays: number[];
  dailySendCap: number;
}

export interface ICampaign extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  fileId: mongoose.Types.ObjectId;

  // Multi-step sequence created alongside the campaign on wizard launch.
  sequenceId?: mongoose.Types.ObjectId;

  audienceFilters?: ICampaignAudienceFilters;
  replyRules?: ICampaignReplyRules;
  schedule?: ICampaignSchedule;

  outreachConfig: {
    channel: (typeof OUTREACH_CHANNELS)[number];
    tone: string;
    language: string;
    personalization: string[];
    systemPromptOverride?: string;
  };
  stats: {
    totalLeads: number;
    draftsCreated: number;
    sent: number;
    opened: number;
    replied: number;
    bounced: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const audienceFiltersSchema = new Schema<ICampaignAudienceFilters>({
  hotOnly: { type: Boolean, default: false },
  verifiedOnly: { type: Boolean, default: false },
}, { _id: false });

const replyRulesSchema = new Schema<ICampaignReplyRules>({
  pauseOnReply: { type: Boolean, default: true },
  classify: { type: Boolean, default: false },
  notifyChannel: { type: String, enum: ['slack', 'email', 'none'], default: 'none' },
}, { _id: false });

const scheduleSchema = new Schema<ICampaignSchedule>({
  timezone: { type: String, required: true },
  startHour: { type: Number, required: true, min: 0, max: 23 },
  endHour: { type: Number, required: true, min: 1, max: 24 },
  allowedDays: { type: [Number], default: [1, 2, 3, 4, 5] },
  dailySendCap: { type: Number, default: 100, min: 1, max: 5000 },
}, { _id: false });

const campaignSchema = new Schema<ICampaign>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 1000 },
    status: {
      type: String,
      enum: CAMPAIGN_STATUSES,
      default: 'draft',
    },
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true, index: true },

    sequenceId: { type: Schema.Types.ObjectId, ref: 'Sequence', index: true },

    audienceFilters: { type: audienceFiltersSchema },
    replyRules: { type: replyRulesSchema },
    schedule: { type: scheduleSchema },

    outreachConfig: {
      type: new Schema({
        channel: { type: String, enum: OUTREACH_CHANNELS },
        tone: { type: String, required: true },
        language: { type: String, default: 'English' },
        personalization: { type: [String], default: [] },
        systemPromptOverride: { type: String },
      }, { _id: false }),
      required: true,
    },
    stats: {
      totalLeads: { type: Number, default: 0 },
      draftsCreated: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      opened: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      bounced: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

campaignSchema.index({ workspaceId: 1, status: 1 });

export default mongoose.model<ICampaign>('Campaign', campaignSchema);
