import mongoose, { Schema } from 'mongoose';
import {
  LEAD_EMAIL_TYPES,
  PHONE_TYPES,
  OUTREACH_STATUSES,
  SOURCE_TYPES,
  QUALIFICATION_STATUSES,
  QualificationStatus,
} from '../../shared/index.js';

export interface ILead extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  companyName: string;
  companyDomain?: string;
  companyType?: string;
  industry?: string;
  subIndustry?: string;
  description?: string;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    country?: string;
    postcode?: string;
    fullText?: string;
  };
  emails: Array<{
    address: string;
    type: (typeof LEAD_EMAIL_TYPES)[number];
    confidence: number;
    verified: boolean;
    verifiedAt?: Date;
    source: string;
  }>;
  phones: Array<{
    raw: string;
    normalized?: string;
    type?: (typeof PHONE_TYPES)[number];
    countryCode?: string;
    source: string;
  }>;
  socialProfiles?: {
    linkedinUrl?: string;
    twitterUrl?: string;
    facebookUrl?: string;
    instagramUrl?: string;
  };
  website?: string;
  osint?: Record<string, unknown>;
  sources: Array<{
    url: string;
    type: (typeof SOURCE_TYPES)[number];
    scrapedAt: Date;
    confidence: number;
  }>;
  rawSnippets: string[];
  rankScore: number;
  completenessScore: number;
  isVerified: boolean;
  isDuplicate: boolean;
  mergedIntoId?: mongoose.Types.ObjectId;
  outreachStatus: (typeof OUTREACH_STATUSES)[number];
  qualificationStatus: QualificationStatus;
  qualificationScore?: number;
  qualificationReason?: string;
  /** The agent's own justification for emitting this lead. Captured at
   *  `write_lead` time as the `reasoning` argument the agent passes
   *  alongside the lead payload. Complements `qualificationReason`
   *  which is the post-hoc grader's verdict — `agentReasoning` is the
   *  pre-commit "why I'm writing this" from the research agent itself. */
  agentReasoning?: string;
  tags: string[];
  notes?: string;
  suppressedAt?: Date;
  suppressReason?: string;
  contactIds: mongoose.Types.ObjectId[];
  contactSummary?: {
    totalContacts: number;
    topContact?: {
      fullName: string;
      title: string;
      seniority: 'c_level' | 'vp' | 'director' | 'manager' | 'ic' | 'unknown';
    };
  };
  crmRefs: Array<{
    provider: 'hubspot' | 'salesforce' | 'pipedrive' | 'close';
    externalId: string;
    syncedAt: Date;
    syncStatus: 'synced' | 'error' | 'pending';
    errorMessage?: string;
  }>;
  /**
   * Query-specific payload fields. Keys match the job's `parsedIntent.outputSchema[i].key`.
   * Empty/undefined when the query requested only standard contact fields.
   *
   * Each value is { value, unit?, sourceUrl?, confidence?, raw? }; shape
   * mirrors FactValue in shared. Using Mixed because the value types vary
   * by the column's declared type (currency, date, tags, etc.).
   */
  facts?: Record<string, {
    value: string | number | boolean | string[] | null;
    unit?: string;
    sourceUrl?: string;
    confidence?: number;
    raw?: string;
  }>;
  /** Rollup: fraction (0-1) of the job's required schema columns that have a value. */
  schemaFulfillmentPct?: number;
  createdAt: Date;
  updatedAt: Date;
}

const leadSchema = new Schema<ILead>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'ProspectingJob', required: true },
    companyName: { type: String, required: true, trim: true },
    companyDomain: { type: String, lowercase: true, trim: true },
    companyType: { type: String },
    industry: { type: String },
    subIndustry: { type: String },
    description: { type: String },
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      country: { type: String },
      postcode: { type: String },
      fullText: { type: String },
    },
    emails: [
      {
        address: { type: String, required: true },
        type: { type: String, enum: LEAD_EMAIL_TYPES },
        confidence: { type: Number, min: 0, max: 1, default: 0.5 },
        verified: { type: Boolean, default: false },
        verifiedAt: { type: Date },
        source: { type: String, required: true },
      },
    ],
    phones: [
      {
        raw: { type: String, required: true },
        normalized: { type: String },
        type: { type: String, enum: PHONE_TYPES },
        countryCode: { type: String },
        source: { type: String, required: true },
      },
    ],
    socialProfiles: {
      linkedinUrl: { type: String },
      twitterUrl: { type: String },
      facebookUrl: { type: String },
      instagramUrl: { type: String },
    },
    website: { type: String },
    osint: { type: Schema.Types.Mixed },
    sources: [
      {
        url: { type: String, required: true },
        type: { type: String, enum: SOURCE_TYPES },
        scrapedAt: { type: Date, default: Date.now },
        confidence: { type: Number, min: 0, max: 1, default: 0.5 },
      },
    ],
    rawSnippets: { type: [String], default: [] },
    rankScore: { type: Number, default: 0, min: 0, max: 100 },
    completenessScore: { type: Number, default: 0, min: 0, max: 100 },
    isVerified: { type: Boolean, default: false },
    isDuplicate: { type: Boolean, default: false },
    mergedIntoId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    outreachStatus: { type: String, enum: OUTREACH_STATUSES, default: 'not_contacted' },
    qualificationStatus: { type: String, enum: QUALIFICATION_STATUSES, default: 'pending' },
    qualificationScore: { type: Number, min: 0, max: 1 },
    qualificationReason: { type: String },
    agentReasoning: { type: String, maxlength: 2000 },
    tags: { type: [String], default: [] },
    notes: { type: String, maxlength: 5000 },
    suppressedAt: { type: Date },
    suppressReason: { type: String },
    contactIds: [{ type: Schema.Types.ObjectId, ref: 'Contact' }],
    contactSummary: {
      totalContacts: { type: Number, default: 0 },
      topContact: {
        fullName: String,
        title: String,
        seniority: String,
      },
    },
    crmRefs: {
      type: [
        {
          provider: { type: String, enum: ['hubspot', 'salesforce', 'pipedrive', 'close'], required: true },
          externalId: { type: String, required: true },
          syncedAt: { type: Date, required: true },
          syncStatus: { type: String, enum: ['synced', 'error', 'pending'], required: true },
          errorMessage: String,
        },
      ],
      default: [],
    },
    // Query-specific column values. Keys match job.parsedIntent.outputSchema[i].key.
    // Mixed because value types are determined per-column by the schema's `type`.
    facts: { type: Schema.Types.Mixed, default: undefined },
    schemaFulfillmentPct: { type: Number, min: 0, max: 1 },
  },
  { timestamps: true }
);

leadSchema.index({ workspaceId: 1 });
leadSchema.index({ jobId: 1 });
leadSchema.index({ companyDomain: 1 });
leadSchema.index({ rankScore: -1 });
leadSchema.index({ industry: 1 });
leadSchema.index({ 'address.country': 1 });
leadSchema.index({ companyName: 'text', description: 'text' });
// Unique on (workspaceId, companyDomain) but only for non-empty domains.
// Sparse indexes don't actually help here — they include null and empty
// strings in the unique check, which conflicts when multiple domain-less
// leads (small SMEs / bukkas) need to coexist in the same workspace.
// The partial filter excludes both empty strings and missing values.
leadSchema.index(
  { workspaceId: 1, companyDomain: 1 },
  { unique: true, partialFilterExpression: { companyDomain: { $type: 'string', $gt: '' } } },
);
leadSchema.index({ workspaceId: 1, isDuplicate: 1, rankScore: -1 });
leadSchema.index({ workspaceId: 1, qualificationStatus: 1 });

export default mongoose.model<ILead>('Lead', leadSchema);
