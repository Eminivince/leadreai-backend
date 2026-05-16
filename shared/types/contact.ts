export type SeniorityLevel = 'c_level' | 'vp' | 'director' | 'manager' | 'ic' | 'unknown';
export type Department = 'sales' | 'marketing' | 'engineering' | 'finance' | 'hr' | 'legal' | 'operations' | 'other';
export type BuyingRole = 'champion' | 'economic_buyer' | 'technical_buyer' | 'blocker' | 'influencer' | 'unknown';
export type ContactEmailType = 'direct' | 'pattern_inferred' | 'generic';
export type ContactPhoneType = 'mobile' | 'direct' | 'office';
export type ContactSourceType = 'linkedin' | 'company_website' | 'press_release' | 'directory' | 'pattern_inferred';
export type CrmProvider = 'hubspot' | 'salesforce' | 'pipedrive' | 'close';
export type CrmSyncStatus = 'synced' | 'error' | 'pending';

export interface IContactEmail {
  address: string;
  type: ContactEmailType;
  confidence: number;
  verified: boolean;
  source: string;
}

export interface IContactPhone {
  normalized: string;
  type: ContactPhoneType;
  source: string;
}

export interface IContactSource {
  url: string;
  type: ContactSourceType;
  scrapedAt: Date;
  confidence: number;
}

export interface ICrmRef {
  provider: CrmProvider;
  externalId: string;
  syncedAt: Date;
  syncStatus: CrmSyncStatus;
  errorMessage?: string;
}

export interface IContact {
  _id: string;
  workspaceId: string;
  leadId?: string;
  jobId?: string;
  firstName?: string;
  lastName?: string;
  fullName: string;
  title?: string;
  department?: Department;
  seniority?: SeniorityLevel;
  linkedinUrl?: string;
  twitterUrl?: string;
  avatarUrl?: string;
  emails: IContactEmail[];
  phones: IContactPhone[];
  buyingRole?: BuyingRole;
  sources: IContactSource[];
  confidenceScore: number;
  freshnessScore: number;
  verifiedAt?: Date;
  crmRefs: ICrmRef[];
  isActive: boolean;
  notes?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IContactSummary {
  totalContacts: number;
  topContact?: {
    fullName: string;
    title: string;
    seniority: SeniorityLevel;
  };
}
