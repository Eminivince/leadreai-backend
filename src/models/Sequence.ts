import mongoose, { Schema } from 'mongoose';
import { SEQUENCE_STATUSES, type SequenceStatus } from '../../shared/index.js';

export interface ISequenceDoc extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  status: SequenceStatus;
  steps: Array<{
    _id: mongoose.Types.ObjectId;
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
    // Per-step personalization hints. When useAI=true, the sequence worker
    // (M2) calls the Claude outreach draft service at send time with these
    // hints + the lead's evidence rather than rendering emailTemplate
    // literally. The template is still stored as a fallback / authored base.
    useAI?: boolean;
    tone?: string;
    goal?: string;
  }>;
  stopRules: Array<{
    trigger: 'any_reply' | 'positive_reply' | 'unsubscribe' | 'bounce';
    action: 'stop_sequence' | 'pause_sequence';
  }>;
  stats: {
    totalEnrolled: number;
    active: number;
    completed: number;
    replied: number;
    bounced: number;
    unsubscribed: number;
  };
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const sendWindowSchema = new Schema({
  startHour: { type: Number, min: 0, max: 23, required: true },
  endHour: { type: Number, min: 0, max: 24, required: true },
  timezone: { type: String, required: true },
  allowedDays: [{ type: Number, min: 0, max: 6 }],
}, { _id: false });

const stepSchema = new Schema({
  stepNumber: { type: Number, required: true, min: 1 },
  channel: { type: String, enum: ['email', 'linkedin', 'sms'], default: 'email' },
  delayDays: { type: Number, required: true, min: 0, default: 0 },
  sendWindow: { type: sendWindowSchema },
  emailTemplate: {
    subject: String,
    body: String,
    fromName: String,
    replyTo: String,
  },
  useAI: { type: Boolean, default: false },
  tone: { type: String, maxlength: 50 },
  goal: { type: String, maxlength: 200 },
}, { _id: false });

const sequenceSchema = new Schema<ISequenceDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 1000 },
    status: { type: String, enum: SEQUENCE_STATUSES, default: 'draft' },
    steps: { type: [stepSchema], default: [] },
    stopRules: {
      type: [
        {
          trigger: { type: String, enum: ['any_reply', 'positive_reply', 'unsubscribe', 'bounce'], required: true },
          action: { type: String, enum: ['stop_sequence', 'pause_sequence'], required: true },
        },
      ],
      default: [
        { trigger: 'any_reply', action: 'stop_sequence' },
        { trigger: 'unsubscribe', action: 'stop_sequence' },
        { trigger: 'bounce', action: 'stop_sequence' },
      ],
    },
    stats: {
      totalEnrolled: { type: Number, default: 0 },
      active: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      bounced: { type: Number, default: 0 },
      unsubscribed: { type: Number, default: 0 },
    },
    tags: { type: [String], default: [] },
  },
  { timestamps: true },
);

sequenceSchema.index({ workspaceId: 1, status: 1 });
sequenceSchema.index({ workspaceId: 1, createdAt: -1 });

export default mongoose.model<ISequenceDoc>('Sequence', sequenceSchema);
