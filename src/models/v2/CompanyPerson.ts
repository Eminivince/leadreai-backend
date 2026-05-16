import mongoose, { Schema } from 'mongoose';

/**
 * Edge between a Person and a Company. A person may be (Founder, CEO) at
 * CompanyA and (Board Member) at CompanyB simultaneously, or former-employee
 * at CompanyC. Keep as many edges as we know about — `endDate` null means current.
 *
 * Canonical role and seniority fields are derived from the raw title by the
 * persona classifier — they're what queries filter on.
 */

export type Seniority = 'c_level' | 'vp' | 'head' | 'director' | 'manager' | 'ic' | 'advisor' | 'board' | 'unknown';
export type Department = 'executive' | 'engineering' | 'product' | 'design' | 'growth' | 'marketing' | 'sales' | 'partnerships'
                       | 'operations' | 'finance' | 'legal' | 'compliance' | 'hr' | 'procurement' | 'it' | 'customer_success' | 'other';

export interface ICompanyPerson extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  personId: mongoose.Types.ObjectId;
  title: string;                      // raw title as scraped: "Head of Partnerships"
  canonicalRole?: string;             // normalized: 'head_of_partnerships' | 'founder' | 'ceo'
  seniority: Seniority;
  department: Department;
  isFounder: boolean;
  startDate?: Date;
  endDate?: Date | null;              // null = current
  createdAt: Date;
  updatedAt: Date;
}

const companyPersonSchema = new Schema<ICompanyPerson>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'CompanyV2', required: true, index: true },
    personId: { type: Schema.Types.ObjectId, ref: 'PersonV2', required: true, index: true },
    title: { type: String, required: true, trim: true },
    canonicalRole: { type: String, lowercase: true, trim: true, index: true },
    seniority: { type: String, enum: ['c_level', 'vp', 'head', 'director', 'manager', 'ic', 'advisor', 'board', 'unknown'], default: 'unknown' },
    department: { type: String, enum: ['executive', 'engineering', 'product', 'design', 'growth', 'marketing', 'sales', 'partnerships', 'operations', 'finance', 'legal', 'compliance', 'hr', 'procurement', 'it', 'customer_success', 'other'], default: 'other' },
    isFounder: { type: Boolean, default: false },
    startDate: { type: Date },
    endDate: { type: Date },
  },
  { timestamps: true, collection: 'company_persons_v2' },
);

companyPersonSchema.index({ workspaceId: 1, companyId: 1, personId: 1 }, { unique: true });
companyPersonSchema.index({ workspaceId: 1, seniority: 1, department: 1 });
companyPersonSchema.index({ workspaceId: 1, isFounder: 1 });

export default mongoose.models['CompanyPersonV2'] as mongoose.Model<ICompanyPerson>
  ?? mongoose.model<ICompanyPerson>('CompanyPersonV2', companyPersonSchema);
