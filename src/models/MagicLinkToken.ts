import mongoose, { Schema } from 'mongoose';

export interface IMagicLinkToken extends mongoose.Document {
  email: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  requestIp?: string;
  createdAt: Date;
}

const magicLinkTokenSchema = new Schema<IMagicLinkToken>(
  {
    // Lowercased email the link was sent to. Never the raw token — we
    // store only a SHA-256 of it so a DB leak doesn't yield usable links.
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    // Mongo TTL — once expiresAt passes, the doc is dropped by the
    // index's background sweep (~60s resolution). Verify checks
    // expiresAt explicitly before that happens to keep the guarantee
    // tight even during the sweep gap.
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    requestIp: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

magicLinkTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
magicLinkTokenSchema.index({ email: 1, createdAt: -1 });

export default mongoose.model<IMagicLinkToken>('MagicLinkToken', magicLinkTokenSchema);
