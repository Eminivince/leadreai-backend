import mongoose, { Schema } from 'mongoose';
import { OUTREACH_CHANNELS } from '../../shared/index.js';

export interface IOutreachDraft extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  campaignId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  channel: (typeof OUTREACH_CHANNELS)[number];
  firstLine?: string;
  subject?: string;
  body: string;
  tone: string;
  language: string;
  promptUsed: string;
  modelResponse: string;
  version: number;
  status: 'draft' | 'approved' | 'sent' | 'failed';
  reasoning?: string;
  sentAt?: Date;
  deliveryMetadata?: {
    provider?: string;
    messageId?: string;
    threadId?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const outreachDraftSchema = new Schema<IOutreachDraft>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: OUTREACH_CHANNELS, required: true },
    firstLine: { type: String },
    subject: { type: String },
    body: { type: String, required: true },
    tone: { type: String, required: true },
    language: { type: String, default: 'English' },
    promptUsed: { type: String, required: true, select: false },
    modelResponse: { type: String, required: true, select: false },
    version: { type: Number, default: 1 },
    status: { type: String, enum: ['draft', 'approved', 'sent', 'failed'], default: 'draft' },
    reasoning: { type: String, select: false },
    sentAt: { type: Date },
    deliveryMetadata: {
      provider: { type: String },
      messageId: { type: String },
      threadId: { type: String },
    },
  },
  { timestamps: true }
);

outreachDraftSchema.index({ workspaceId: 1 });
outreachDraftSchema.index({ campaignId: 1 });
outreachDraftSchema.index({ leadId: 1 });
outreachDraftSchema.index({ campaignId: 1, status: 1 });
outreachDraftSchema.index({ 'deliveryMetadata.messageId': 1 }, { sparse: true });

export default mongoose.model<IOutreachDraft>('OutreachDraft', outreachDraftSchema);
