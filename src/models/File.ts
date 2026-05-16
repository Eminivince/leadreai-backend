import mongoose, { Schema } from 'mongoose';

export type FileSource = 'job' | 'manual';

export interface IFile extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  source: FileSource;
  sourceJobId?: mongoose.Types.ObjectId;
  leadIds: mongoose.Types.ObjectId[];
  color?: string;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const fileSchema = new Schema<IFile>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 1000 },
    source: { type: String, enum: ['job', 'manual'], required: true },
    sourceJobId: { type: Schema.Types.ObjectId, ref: 'ProspectingJob' },
    leadIds: [{ type: Schema.Types.ObjectId, ref: 'Lead', default: [] }],
    color: { type: String, maxlength: 24 },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);

fileSchema.index({ workspaceId: 1, archivedAt: 1, updatedAt: -1 });
// Compound sparse indexes don't exclude docs where *one* indexed field is
// missing — only docs where *all* are. Every File has a workspaceId, so
// a `sparse: true` on (workspaceId, sourceJobId) still indexed manual
// files with sourceJobId=null and caused duplicate-key errors when a
// second manual file was created in the same workspace. A partial index
// fixes this by applying the uniqueness constraint only when
// sourceJobId is actually an ObjectId — auto-files from dispatches are
// still deduped (the retry-idempotency story), manual files are not
// constrained at all.
fileSchema.index(
  { workspaceId: 1, sourceJobId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceJobId: { $type: 'objectId' } },
  },
);

export default mongoose.model<IFile>('File', fileSchema);
