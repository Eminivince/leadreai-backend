import mongoose, { Schema } from 'mongoose';

/**
 * Field-level provenance. Every material claim about a company or person
 * has at least one SourceRecord attached — value, where it came from,
 * how we got it, and when. If a field in a Company/Person doc has no
 * SourceRecord, it should be considered suspect.
 *
 * This is what makes "every contact must have a source link" a provable
 * property of the system rather than a hope.
 */

export type EntityType = 'company' | 'person' | 'company_person' | 'signal' | 'contact';

/**
 * Extraction method — how did we learn this value?
 *  - 'scrape':        HTML scraped from a public page (URL required)
 *  - 'api':           structured API response (Hunter, BuiltWith, OpenCorporates)
 *  - 'registry':      government or public registry lookup
 *  - 'llm_extract':   LLM extracted from a scraped page (lower confidence)
 *  - 'llm_infer':     LLM inferred without a specific source (guess)
 *  - 'pattern':       deterministic pattern (e.g. email pattern inference)
 *  - 'smtp_verify':   MX/SMTP probe result
 *  - 'mx_valid':      MX record validation result
 *  - 'libphone':      libphonenumber validation
 *  - 'user_input':    supplied by the workspace user
 *  - 'import':        imported from CSV/API integration (Hubspot, Salesforce)
 */
export type ExtractionMethod =
  | 'scrape' | 'api' | 'registry'
  | 'llm_extract' | 'llm_infer' | 'pattern'
  | 'smtp_verify' | 'mx_valid' | 'libphone'
  | 'user_input' | 'import';

export interface ISourceRecord extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  entityType: EntityType;
  entityId: mongoose.Types.ObjectId;       // CompanyV2 / PersonV2 / CompanyPersonV2 / Signal / ContactV2
  field: string;                            // 'emails[0].address' | 'industry' | 'topContact.title' — dot path into the entity
  value: unknown;                           // the exact value stored for that field
  sourceUrl?: string;                       // required unless method is 'smtp_verify' / 'libphone' / 'user_input'
  method: ExtractionMethod;
  confidence: number;                       // 0-1
  verifiedAt: Date;
  providerId?: string;                      // 'hunter' | 'serpapi:google' | 'opencorporates:NG' | 'builtwith' | 'website_scrape'
  /** Raw evidence snippet (first ~500 chars of scraped HTML / JSON) for auditability. */
  evidenceSnippet?: string;
  /** The job that surfaced this source — useful for cost attribution and replay. */
  jobId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const sourceRecordSchema = new Schema<ISourceRecord>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    entityType: { type: String, enum: ['company', 'person', 'company_person', 'signal', 'contact'], required: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    field: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
    sourceUrl: { type: String },
    method: { type: String, required: true, enum: ['scrape', 'api', 'registry', 'llm_extract', 'llm_infer', 'pattern', 'smtp_verify', 'mx_valid', 'libphone', 'user_input', 'import'] },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    verifiedAt: { type: Date, default: Date.now },
    providerId: { type: String },
    evidenceSnippet: { type: String, maxlength: 2000 },
    jobId: { type: Schema.Types.ObjectId, ref: 'ProspectingJob' },
  },
  { timestamps: true, collection: 'source_records' },
);

sourceRecordSchema.index({ workspaceId: 1, entityType: 1, entityId: 1, field: 1 });
sourceRecordSchema.index({ workspaceId: 1, method: 1 });
sourceRecordSchema.index({ jobId: 1 });

/**
 * Helper: record a provenance entry. Centralizing this call site means we can
 * add guardrails later (e.g. "reject if sourceUrl missing and method=scrape").
 */
export interface RecordSourceInput {
  workspaceId: mongoose.Types.ObjectId | string;
  entityType: EntityType;
  entityId: mongoose.Types.ObjectId | string;
  field: string;
  value: unknown;
  sourceUrl?: string;
  method: ExtractionMethod;
  confidence: number;
  providerId?: string;
  evidenceSnippet?: string;
  jobId?: mongoose.Types.ObjectId | string;
}

const METHODS_REQUIRING_SOURCE_URL: ExtractionMethod[] = ['scrape', 'api', 'registry', 'llm_extract'];

export async function recordSource(input: RecordSourceInput): Promise<ISourceRecord> {
  if (METHODS_REQUIRING_SOURCE_URL.includes(input.method) && !input.sourceUrl) {
    throw new Error(`SourceRecord rejected: method=${input.method} requires sourceUrl (field=${input.field})`);
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`SourceRecord rejected: confidence must be finite 0-1 (got ${input.confidence})`);
  }
  return SourceRecord.create({
    workspaceId: new mongoose.Types.ObjectId(input.workspaceId),
    entityType: input.entityType,
    entityId: new mongoose.Types.ObjectId(input.entityId),
    field: input.field,
    value: input.value,
    sourceUrl: input.sourceUrl,
    method: input.method,
    confidence: input.confidence,
    providerId: input.providerId,
    evidenceSnippet: input.evidenceSnippet?.slice(0, 2000),
    jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : undefined,
    verifiedAt: new Date(),
  });
}

const SourceRecord = (mongoose.models['SourceRecord'] as mongoose.Model<ISourceRecord>)
  ?? mongoose.model<ISourceRecord>('SourceRecord', sourceRecordSchema);

export default SourceRecord;
