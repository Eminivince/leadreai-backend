import mongoose, { Schema } from 'mongoose';

/**
 * Canonical company record. Distinct from the legacy `Lead` model: a Company
 * represents the entity itself, independent of any particular job. One company
 * → many Persons → many jobs that surfaced them.
 *
 * Fields are intentionally minimal; everything else lives in SourceRecord so
 * we can trace every claim back to a URL + method + timestamp.
 */

export interface ICompany extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  canonicalDomain: string;          // primary key for dedup within a workspace
  legalNames: string[];             // all known legal entity names (e.g. "Aluko & Oyebode", "Aluko and Oyebode")
  aliases: string[];                // brand names, shortened forms, trading names
  websites: string[];               // canonicalDomain first, then any redirects/parked
  industry?: string;                // high-level taxonomy (e.g. 'fintech', 'legal')
  subIndustry?: string;             // more specific (e.g. 'payment_gateway', 'law_firm_commercial')
  size?: 'micro' | 'small' | 'mid' | 'large' | 'enterprise';  // bucketed
  address?: {
    country?: string;
    state?: string;
    city?: string;
    fullText?: string;
  };
  techSignals: string[];            // detected stack elements: ['stripe', 'segment', 'hubspot', ...]
  discoveredAt: Date;               // first time this workspace saw the company
  lastSeenAt: Date;                 // most recent touch
  createdAt: Date;
  updatedAt: Date;
}

const companySchema = new Schema<ICompany>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    canonicalDomain: { type: String, required: true, lowercase: true, trim: true, index: true },
    legalNames: { type: [String], default: [] },
    aliases: { type: [String], default: [] },
    websites: { type: [String], default: [] },
    industry: { type: String },
    subIndustry: { type: String },
    size: { type: String, enum: ['micro', 'small', 'mid', 'large', 'enterprise'] },
    address: {
      country: { type: String },
      state: { type: String },
      city: { type: String },
      fullText: { type: String },
    },
    techSignals: { type: [String], default: [] },
    discoveredAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'companies_v2' },
);

companySchema.index({ workspaceId: 1, canonicalDomain: 1 }, { unique: true });
companySchema.index({ workspaceId: 1, industry: 1 });
companySchema.index({ legalNames: 'text', aliases: 'text' });

export default mongoose.models['CompanyV2'] as mongoose.Model<ICompany>
  ?? mongoose.model<ICompany>('CompanyV2', companySchema);
