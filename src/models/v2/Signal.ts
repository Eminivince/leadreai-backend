import mongoose, { Schema } from 'mongoose';

/**
 * Company-level event. Populated by the signal ingestion pipeline (news,
 * funding APIs, job feeds, filings). Queries like "companies with recent
 * fundraising" filter on these.
 *
 * Signals are immutable — once recorded, they represent a point-in-time fact.
 * Freshness is evaluated at query time from `eventDate`.
 */

export type SignalType =
  | 'fundraising'
  | 'hiring'
  | 'expansion'
  | 'product_launch'
  | 'license_filing'
  | 'compliance_event'
  | 'cross_border'
  | 'acquisition'
  | 'leadership_change'
  | 'press_coverage'
  | 'other';

export interface ISignal extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  type: SignalType;
  eventDate: Date;                   // when the signal event actually occurred (not when we saw it)
  discoveredAt: Date;                // when we ingested it
  title: string;                     // short human label — "raised $10M Series A"
  description?: string;              // longer explanation for prompts/exports
  evidenceUrl: string;               // REQUIRED — signal without a source is a hallucination
  providerId: string;                // 'crunchbase' | 'google_news' | 'linkedin_jobs' | 'cac_filing'
  confidence: number;                // 0-1
  rawPayload?: Record<string, unknown>;  // original API/page snippet for audit
  /** Structured fields for specific signal types. */
  fundraisingAmountUsd?: number;
  fundraisingRound?: string;         // 'seed' | 'series_a' | 'series_b' | ...
  hiringRolesSignal?: string[];      // titles in the open job listings
  createdAt: Date;
  updatedAt: Date;
}

const signalSchema = new Schema<ISignal>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'CompanyV2', required: true, index: true },
    type: {
      type: String,
      enum: ['fundraising', 'hiring', 'expansion', 'product_launch', 'license_filing', 'compliance_event', 'cross_border', 'acquisition', 'leadership_change', 'press_coverage', 'other'],
      required: true,
    },
    eventDate: { type: Date, required: true, index: true },
    discoveredAt: { type: Date, default: Date.now },
    title: { type: String, required: true, maxlength: 500 },
    description: { type: String, maxlength: 5000 },
    evidenceUrl: { type: String, required: true },
    providerId: { type: String, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    rawPayload: { type: Schema.Types.Mixed },
    fundraisingAmountUsd: { type: Number },
    fundraisingRound: { type: String },
    hiringRolesSignal: { type: [String], default: undefined },
  },
  { timestamps: true, collection: 'signals' },
);

signalSchema.index({ workspaceId: 1, companyId: 1, eventDate: -1 });
signalSchema.index({ workspaceId: 1, type: 1, eventDate: -1 });
signalSchema.index({ workspaceId: 1, eventDate: -1 });

export default mongoose.models['Signal'] as mongoose.Model<ISignal>
  ?? mongoose.model<ISignal>('Signal', signalSchema);
