import mongoose, { Schema } from 'mongoose';
import { ENROLLMENT_STATUSES, STEP_STATUSES, type EnrollmentStatus, type StepStatus } from '../../shared/index.js';

export interface ISequenceEnrollmentDoc extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  sequenceId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  contactId?: mongoose.Types.ObjectId;
  enrolledBy: mongoose.Types.ObjectId;
  status: EnrollmentStatus;
  currentStep: number;
  nextStepAt?: Date;
  completedAt?: Date;
  stopReason?: string;
  stepHistory: Array<{
    stepNumber: number;
    sentAt?: Date;
    deliveredAt?: Date;
    openedAt?: Date;
    clickedAt?: Date;
    repliedAt?: Date;
    bouncedAt?: Date;
    bounceType?: 'hard' | 'soft';
    status: StepStatus;
    messageId?: string;
    errorMessage?: string;
    toEmail?: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const stepHistorySchema = new Schema({
  stepNumber: { type: Number, required: true },
  sentAt: Date,
  deliveredAt: Date,
  openedAt: Date,
  clickedAt: Date,
  repliedAt: Date,
  bouncedAt: Date,
  bounceType: { type: String, enum: ['hard', 'soft'] },
  status: { type: String, enum: STEP_STATUSES, default: 'pending' },
  messageId: String,
  errorMessage: String,
  toEmail: String,
}, { _id: false });

const enrollmentSchema = new Schema<ISequenceEnrollmentDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    sequenceId: { type: Schema.Types.ObjectId, ref: 'Sequence', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    enrolledBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ENROLLMENT_STATUSES, default: 'active' },
    currentStep: { type: Number, default: 1, min: 1 },
    nextStepAt: Date,
    completedAt: Date,
    stopReason: String,
    stepHistory: { type: [stepHistorySchema], default: [] },
  },
  { timestamps: true },
);

enrollmentSchema.index({ workspaceId: 1, status: 1, nextStepAt: 1 });
enrollmentSchema.index({ sequenceId: 1, leadId: 1 }, { unique: true });
enrollmentSchema.index({ leadId: 1, status: 1 });
enrollmentSchema.index({ 'stepHistory.messageId': 1 }, { sparse: true });

export default mongoose.model<ISequenceEnrollmentDoc>('SequenceEnrollment', enrollmentSchema);
