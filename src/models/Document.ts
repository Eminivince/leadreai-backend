import mongoose, { Schema } from 'mongoose';

export const DOCUMENT_STATUSES = [
  'pending',   // just uploaded, worker hasn't picked it up
  'parsing',   // extracting text
  'embedding', // parsed; now embedding chunks
  'ready',     // fully processed, searchable
  'failed',    // terminal error
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface IDocument extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  uploadedBy: mongoose.Types.ObjectId;
  originalFilename: string;
  title?: string;
  fileType: string;
  mimeType?: string;
  bytes: number;
  storagePath: string;       // abstract key handed to StorageService
  status: DocumentStatus;
  errorMessage?: string;
  pageCount?: number;
  chunkCount?: number;
  meta?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new Schema<IDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    originalFilename: { type: String, required: true, trim: true, maxlength: 255 },
    // Display name — defaults to originalFilename but can be edited.
    title: { type: String, trim: true, maxlength: 255 },
    fileType: { type: String, required: true, maxlength: 16 },
    mimeType: { type: String, maxlength: 128 },
    bytes: { type: Number, required: true, min: 0 },
    storagePath: { type: String, required: true, maxlength: 512 },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'pending' },
    errorMessage: { type: String, maxlength: 2000 },
    pageCount: { type: Number },
    chunkCount: { type: Number },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

documentSchema.index({ workspaceId: 1, createdAt: -1 });
documentSchema.index({ workspaceId: 1, status: 1 });

export default mongoose.model<IDocument>('Document', documentSchema);
