import mongoose, { Schema } from 'mongoose';
import { WORKSPACE_ROLES, KNOWLEDGE_BASE_ENTRY_TYPES, KnowledgeBaseEntryType } from '../../shared/index.js';

export type EmailProvider = 'smtp' | 'resend' | 'sendgrid' | 'gmail';

export interface IEmailConfig {
  provider: EmailProvider;
  fromEmail: string;
  fromName: string;
  replyTo?: string;
  // API-key providers (resend, sendgrid) — stored encrypted
  apiKey?: string;
  // SMTP
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string; // stored encrypted
  verifiedAt?: Date;
  // Gmail OAuth
  gmail?: {
    accessToken?: string;  // encrypted
    refreshToken?: string; // encrypted
    expiresAt?: Date;
    email?: string;
  };
}

export interface IWorkspace extends mongoose.Document {
  name: string;
  slug: string;
  ownerId: mongoose.Types.ObjectId;
  /** Multi-client agency mode (Task #11): when set, this workspace is
   *  a client sub-workspace owned by the parent agency workspace. Members
   *  + admins of the parent automatically inherit access. */
  parentWorkspaceId?: mongoose.Types.ObjectId;
  /** Convenience flag mirroring `parentWorkspaceId != null`. Indexed so
   *  the main workspace list can filter `isClient: false` cheaply. */
  isClient?: boolean;
  /** Display label used on dashboards + exports when the agency wants to
   *  show "Working for Acme Corp" vs the workspace's bare name. */
  clientLabel?: string;
  /** White-label branding (Task #12). Used on exports + client-facing
   *  surfaces. Child workspaces inherit parent branding when their own
   *  block is unset. */
  branding?: {
    displayName?: string;
    logoUrl?: string;
    contactEmail?: string;
    reportTitle?: string;
  };
  /** Cost budget controls (Task #15). The periodic budget checker emits
   *  a notification when month-to-date spend crosses `alertThresholdPct`
   *  of `monthlyCapUSD`. `alertedAt` is the wall-clock when the most
   *  recent notification was emitted; the checker uses it to avoid
   *  re-firing within the same calendar month. */
  budget?: {
    monthlyCapUSD?: number;
    alertThresholdPct?: number;
    alertedAt?: Date;
  };
  /** SAML SSO (Task #20). Enterprise tier only — gated by plan check
   *  on the config endpoint. The IdP delivers SAML assertions to
   *  /api/v1/auth/saml/:workspaceId/acs; we map NameID → email and
   *  provision the user if their email domain matches `domain`. */
  ssoConfig?: {
    enabled: boolean;
    entryPoint: string;
    issuer: string;
    cert: string;
    domain?: string;
  };
  /** Per-workspace audit-log retention override (Task #21). When set,
   *  AuditLog rows for this workspace expire after `auditRetentionDays`
   *  rather than the global 90-day default. Setting to 0 keeps audit
   *  rows forever — enterprise customers with regulatory holds use
   *  this. */
  auditRetentionDays?: number;
  members: Array<{
    userId: mongoose.Types.ObjectId;
    role: (typeof WORKSPACE_ROLES)[number];
    joinedAt: Date;
  }>;
  emailConfig?: IEmailConfig;
  settings: {
    defaultExportFormat: 'csv' | 'xlsx';
    notifyOnJobComplete: boolean;
    cheapMode: boolean;
    webhookUrl?: string;
  };
  knowledgeBase: Array<{
    _id: mongoose.Types.ObjectId;
    title: string;
    content: string;
    type: KnowledgeBaseEntryType;
    createdAt: Date;
    updatedAt: Date;
  }>;
  apiKeys: Array<{
    _id: mongoose.Types.ObjectId;
    name: string;
    keyHash: string;
    prefix: string;
    createdAt: Date;
    lastUsedAt?: Date;
  }>;
  usageStats: {
    totalJobsRun: number;
    totalLeadsFound: number;
    totalExports: number;
    creditsUsed: number;
  };
  crmConfig?: {
    provider: 'hubspot';
    hubspot?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt: Date;
      portalId: string;
      syncEnabled: boolean;
      autoSyncOnJobComplete: boolean;
      lastSyncAt?: Date;
      syncLog: Array<{
        syncedAt: Date;
        direction: 'push' | 'pull';
        companiesSynced: number;
        contactsSynced: number;
        errors: number;
      }>;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

const workspaceSchema = new Schema<IWorkspace>(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    parentWorkspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', index: true },
    isClient: { type: Boolean, default: false, index: true },
    clientLabel: { type: String, maxlength: 200 },
    branding: {
      displayName: { type: String, maxlength: 200 },
      logoUrl: { type: String, maxlength: 1024 },
      contactEmail: { type: String, maxlength: 320 },
      reportTitle: { type: String, maxlength: 240 },
    },
    budget: {
      monthlyCapUSD: { type: Number, min: 0 },
      alertThresholdPct: { type: Number, min: 1, max: 100, default: 80 },
      alertedAt: { type: Date },
    },
    ssoConfig: {
      enabled: { type: Boolean, default: false },
      entryPoint: { type: String, maxlength: 1024 },
      issuer: { type: String, maxlength: 512 },
      cert: { type: String, maxlength: 8192, select: false },
      domain: { type: String, maxlength: 320 },
    },
    auditRetentionDays: { type: Number, min: 0, max: 3650 },
    members: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'User' },
        role: { type: String, enum: WORKSPACE_ROLES },
        joinedAt: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    emailConfig: {
      provider: { type: String, enum: ['smtp', 'resend', 'sendgrid', 'gmail'] },
      fromEmail: { type: String },
      fromName: { type: String },
      replyTo: { type: String },
      apiKey: { type: String, select: false },      // encrypted
      smtpHost: { type: String },
      smtpPort: { type: Number },
      smtpSecure: { type: Boolean },
      smtpUser: { type: String },
      smtpPass: { type: String, select: false },    // encrypted
      verifiedAt: { type: Date },
      gmail: {
        accessToken: { type: String, select: false },
        refreshToken: { type: String, select: false },
        expiresAt: { type: Date },
        email: { type: String },
        /** Last seen Gmail history id — cursor for the inbound poller. */
        lastHistoryId: { type: String },
      },
    },
    settings: {
      defaultExportFormat: { type: String, enum: ['csv', 'xlsx'], default: 'csv' },
      notifyOnJobComplete: { type: Boolean, default: true },
      cheapMode: { type: Boolean, default: false },
      webhookUrl: { type: String },
    },
    knowledgeBase: {
      type: [
        {
          title: { type: String, required: true, trim: true, maxlength: 200 },
          content: { type: String, required: true, maxlength: 2000 },
          type: {
            type: String,
            enum: KNOWLEDGE_BASE_ENTRY_TYPES,
            default: 'other',
          },
          createdAt: { type: Date, default: Date.now },
          updatedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    apiKeys: {
      type: [
        {
          name: { type: String, required: true, maxlength: 100 },
          keyHash: { type: String, required: true, select: false },
          prefix: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
          lastUsedAt: { type: Date },
        },
      ],
      default: [],
    },
    usageStats: {
      totalJobsRun: { type: Number, default: 0 },
      totalLeadsFound: { type: Number, default: 0 },
      totalExports: { type: Number, default: 0 },
      creditsUsed: { type: Number, default: 0 },
    },
    crmConfig: {
      provider: { type: String, enum: ['hubspot', 'salesforce', 'pipedrive', 'close'] },
      hubspot: {
        accessToken: { type: String, select: false },
        refreshToken: { type: String, select: false },
        expiresAt: Date,
        portalId: String,
        syncEnabled: { type: Boolean, default: false },
        autoSyncOnJobComplete: { type: Boolean, default: false },
        lastSyncAt: Date,
        syncLog: [
          {
            syncedAt: { type: Date, required: true },
            direction: { type: String, enum: ['push', 'pull'], required: true },
            companiesSynced: { type: Number, default: 0 },
            contactsSynced: { type: Number, default: 0 },
            errors: { type: Number, default: 0 },
          },
        ],
      },
    },
  },
  { timestamps: true }
);

workspaceSchema.index({ ownerId: 1 });
workspaceSchema.index({ 'members.userId': 1 });

export default mongoose.model<IWorkspace>('Workspace', workspaceSchema);
