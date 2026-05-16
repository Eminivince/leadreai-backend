export const JOB_STATUSES = [
  'queued',
  'parsing',
  'collecting',
  'enriching',
  'deduplicating',
  'complete',
  'failed',
  'cancelled',
] as const;

export const OUTREACH_CHANNELS = ['email', 'linkedin', 'sms'] as const;

export const PLAN_TIERS = ['free', 'growth', 'enterprise'] as const;

export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;

export const LEAD_EMAIL_TYPES = [
  'business',
  'generic',
  'personal',
  'pattern_inferred',
] as const;

export const PHONE_TYPES = ['office', 'mobile', 'fax'] as const;

export const OUTREACH_STATUSES = [
  'not_contacted',
  'draft_created',
  'sent',
  'replied',
  'bounced',
  'unsubscribed',
] as const;

export const SOURCE_TYPES = [
  'serpapi',
  'scraped_page',
  'pdf',
  'docx',
  'xlsx',
  'whois',
  'dns',
  'ssl',
  'linkedin',
] as const;

export const DESIRED_FIELDS = [
  'businessEmail', 'officePhone', 'mobilePhone',
  'address', 'website', 'linkedin', 'whois', 'techStack',
] as const;
export type DesiredField = typeof DESIRED_FIELDS[number];

export const QUALIFICATION_STATUSES = ['pending', 'qualified', 'dust'] as const;
export type QualificationStatus = typeof QUALIFICATION_STATUSES[number];

export const KNOWLEDGE_BASE_ENTRY_TYPES = [
  'about_company',
  'value_proposition',
  'target_customer',
  'tone_guidelines',
  'other',
] as const;
export type KnowledgeBaseEntryType = typeof KNOWLEDGE_BASE_ENTRY_TYPES[number];

export const SENIORITY_LEVELS = ['c_level', 'vp', 'director', 'manager', 'ic', 'unknown'] as const;
export const DEPARTMENTS = ['sales', 'marketing', 'engineering', 'finance', 'hr', 'legal', 'operations', 'other'] as const;
export const BUYING_ROLES = ['champion', 'economic_buyer', 'technical_buyer', 'blocker', 'influencer', 'unknown'] as const;
export const CRM_PROVIDERS = ['hubspot', 'salesforce', 'pipedrive', 'close'] as const;
export const CONTACT_EMAIL_TYPES = ['direct', 'pattern_inferred', 'generic'] as const;
export const CONTACT_SOURCE_TYPES = ['linkedin', 'company_website', 'press_release', 'directory', 'pattern_inferred'] as const;

export const SEQUENCE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

export const ENROLLMENT_STATUSES = [
  'active', 'paused', 'completed', 'stopped', 'bounced', 'unsubscribed', 'replied',
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const STEP_STATUSES = [
  'pending', 'sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced', 'failed', 'skipped',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const EMAIL_EVENT_TYPES = [
  'delivered', 'opened', 'clicked', 'bounced', 'complained', 'replied', 'unsubscribed',
] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

export const EMAIL_PROVIDERS = ['resend', 'sendgrid', 'smtp'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];
