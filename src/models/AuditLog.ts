import mongoose, { Schema } from 'mongoose';

export interface IAuditLog extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  action: string;
  resourceType:
    | 'job'
    | 'lead'
    | 'campaign'
    | 'outreach_draft'
    | 'contact'
    | 'workspace'
    | 'sequence'
    | 'file'
    | 'document';
  resourceId: mongoose.Types.ObjectId;
  metadata?: unknown;
  ipAddress?: string;
  userAgent?: string;
  durationMs?: number;
  /** Per-workspace TTL anchor (Task #21). When set, the TTL index on
   *  `expiresAt` removes this row at that time. When unset (enterprise
   *  customers with regulatory holds), the row never expires. */
  expiresAt?: Date;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true, index: true },
    resourceType: {
      type: String,
      enum: [
        'job',
        'lead',
        'campaign',
        'outreach_draft',
        'contact',
        'workspace',
        'sequence',
        'file',
        'document',
      ],
      required: true,
    },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    metadata: { type: Schema.Types.Mixed },
    ipAddress: { type: String },
    userAgent: { type: String },
    durationMs: { type: Number },
    expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Note: TTL index sits on `expiresAt` (set per-row at insert by the
// audit-log writer based on the workspace's auditRetentionDays
// setting). Rows whose expiresAt is unset never expire — that's the
// enterprise-retention path.

export default mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
