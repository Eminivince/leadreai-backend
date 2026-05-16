import mongoose, { Schema } from 'mongoose';

/**
 * Canonical person record. A Person is linked to one or more Companies via
 * CompanyPerson edges — that's where title/seniority/department lives,
 * because the same person may hold roles at multiple companies over time.
 */

export interface IPerson extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  fullName: string;
  firstName?: string;
  lastName?: string;
  preferredEmail?: string;          // the single highest-confidence email
  linkedinUrl?: string;
  twitterHandle?: string;
  githubHandle?: string;
  discoveredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const personSchema = new Schema<IPerson>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    fullName: { type: String, required: true, trim: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    preferredEmail: { type: String, lowercase: true, trim: true },
    linkedinUrl: { type: String },
    twitterHandle: { type: String },
    githubHandle: { type: String },
    discoveredAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'persons_v2' },
);

personSchema.index({ workspaceId: 1, preferredEmail: 1 }, { sparse: true });
personSchema.index({ workspaceId: 1, linkedinUrl: 1 }, { sparse: true });
personSchema.index({ workspaceId: 1, fullName: 'text' });

export default mongoose.models['PersonV2'] as mongoose.Model<IPerson>
  ?? mongoose.model<IPerson>('PersonV2', personSchema);
