import mongoose, { Schema } from 'mongoose';

/**
 * Per-workspace credential blob for a data source. Encrypted with the
 * `dataSource` scope (see utils/encrypt.ts) — distinct salt from email
 * credentials so a leaked key doesn't cross between scopes.
 *
 * Blob structure (after decrypt) is JSON: `{[fieldKey]: value}` where
 * fieldKey matches the DataSource's `auth.fields[].key`. Validation
 * happens at save-time against the source's auth schema.
 */
export interface IDataSourceCredentialDoc extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  dataSourceId: string;
  label?: string;
  encryptedBlob: string;            // always encrypted at rest
  verifiedAt?: Date;
  lastUsedAt?: Date;
  lastErrorAt?: Date;
  lastErrorMessage?: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const dataSourceCredentialSchema = new Schema<IDataSourceCredentialDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    dataSourceId: { type: String, required: true, maxlength: 100 },
    label: { type: String, maxlength: 120 },
    encryptedBlob: { type: String, required: true, select: false },
    verifiedAt: { type: Date },
    lastUsedAt: { type: Date },
    lastErrorAt: { type: Date },
    lastErrorMessage: { type: String, maxlength: 500 },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// One default per (workspace, source). Non-default creds can pile up (user
// can have multiple Apollo keys for separate projects). The partial index
// ensures only ONE default can exist per workspace+source.
dataSourceCredentialSchema.index(
  { workspaceId: 1, dataSourceId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

export default mongoose.model<IDataSourceCredentialDoc>('DataSourceCredential', dataSourceCredentialSchema);
