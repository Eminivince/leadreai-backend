import mongoose, { Schema } from 'mongoose';
import { SENIORITY_LEVELS, DEPARTMENTS, BUYING_ROLES, CRM_PROVIDERS, CONTACT_EMAIL_TYPES, CONTACT_SOURCE_TYPES } from '../../shared/index.js';

export interface IContactDoc extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  leadId?: mongoose.Types.ObjectId;
  jobId?: mongoose.Types.ObjectId;
  firstName?: string;
  lastName?: string;
  fullName: string;
  title?: string;
  department?: 'sales' | 'marketing' | 'engineering' | 'finance' | 'hr' | 'legal' | 'operations' | 'other';
  seniority?: 'c_level' | 'vp' | 'director' | 'manager' | 'ic' | 'unknown';
  linkedinUrl?: string;
  twitterUrl?: string;
  avatarUrl?: string;
  emails: Array<{
    address: string;
    type: 'direct' | 'pattern_inferred' | 'generic';
    confidence: number;
    verified: boolean;
    source: string;
  }>;
  phones: Array<{
    normalized: string;
    type: 'mobile' | 'direct' | 'office';
    source: string;
  }>;
  buyingRole?: 'champion' | 'economic_buyer' | 'technical_buyer' | 'blocker' | 'influencer' | 'unknown';
  sources: Array<{
    url: string;
    type: 'linkedin' | 'company_website' | 'press_release' | 'directory' | 'pattern_inferred';
    scrapedAt: Date;
    confidence: number;
  }>;
  confidenceScore: number;
  freshnessScore: number;
  verifiedAt?: Date;
  crmRefs: Array<{
    provider: 'hubspot' | 'salesforce' | 'pipedrive' | 'close';
    externalId: string;
    syncedAt: Date;
    syncStatus: 'synced' | 'error' | 'pending';
    errorMessage?: string;
  }>;
  isActive: boolean;
  notes?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<IContactDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    jobId: { type: Schema.Types.ObjectId, ref: 'ProspectingJob' },
    firstName: String,
    lastName: String,
    fullName: { type: String, required: true, trim: true },
    title: String,
    department: { type: String, enum: DEPARTMENTS },
    seniority: { type: String, enum: SENIORITY_LEVELS },
    linkedinUrl: String,
    twitterUrl: String,
    avatarUrl: String,
    emails: [
      {
        address: { type: String, required: true, lowercase: true },
        type: { type: String, enum: CONTACT_EMAIL_TYPES, required: true },
        confidence: { type: Number, required: true },
        verified: { type: Boolean, default: false },
        source: { type: String, required: true },
      },
    ],
    phones: [
      {
        normalized: { type: String, required: true },
        type: { type: String, enum: ['mobile', 'direct', 'office'], required: true },
        source: { type: String, required: true },
      },
    ],
    buyingRole: { type: String, enum: BUYING_ROLES },
    sources: [
      {
        url: { type: String, required: true },
        type: { type: String, enum: CONTACT_SOURCE_TYPES, required: true },
        scrapedAt: { type: Date, required: true },
        confidence: { type: Number, required: true },
      },
    ],
    confidenceScore: { type: Number, default: 0, min: 0, max: 100 },
    freshnessScore: { type: Number, default: 100, min: 0, max: 100 },
    verifiedAt: Date,
    crmRefs: [
      {
        provider: { type: String, enum: CRM_PROVIDERS, required: true },
        externalId: { type: String, required: true },
        syncedAt: { type: Date, required: true },
        syncStatus: { type: String, enum: ['synced', 'error', 'pending'], required: true },
        errorMessage: String,
      },
    ],
    isActive: { type: Boolean, default: true },
    notes: String,
    tags: [{ type: String }],
  },
  { timestamps: true },
);

contactSchema.index({ workspaceId: 1, leadId: 1 });
contactSchema.index({ linkedinUrl: 1 }, { sparse: true });
contactSchema.index({ workspaceId: 1, 'emails.address': 1 }, { unique: true, sparse: true }); // dedup: one contact per email per workspace
contactSchema.index({ workspaceId: 1, confidenceScore: -1 });

export const Contact = mongoose.model<IContactDoc>('Contact', contactSchema);
