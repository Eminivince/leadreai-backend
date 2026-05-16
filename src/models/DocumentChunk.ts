import mongoose, { Schema } from 'mongoose';

/**
 * One ~2KB slice of a Document plus its embedding vector.
 *
 * Stored in a separate collection (not embedded in Document) so:
 *   1. A long PDF with 500 chunks doesn't blow the 16MB doc limit.
 *   2. Vector search is a single pass over the chunk collection
 *      scoped by workspaceId, rather than N document loads.
 *
 * Embeddings are float32 arrays stored as Number[] (no BSON binary
 * yet — we can upgrade to Atlas Vector Search later without migrating
 * data, by keeping the key shape identical).
 */
export interface IDocumentChunk extends mongoose.Document {
  workspaceId: mongoose.Types.ObjectId;
  documentId: mongoose.Types.ObjectId;
  idx: number;
  text: string;
  pageHint?: number;
  embedding: number[];
  embeddingModel: string;
  embeddingDims: number;
  createdAt: Date;
}

const documentChunkSchema = new Schema<IDocumentChunk>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
    idx: { type: Number, required: true, min: 0 },
    text: { type: String, required: true },
    pageHint: { type: Number },
    embedding: { type: [Number], default: [] },
    embeddingModel: { type: String, required: true },
    embeddingDims: { type: Number, required: true, min: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

documentChunkSchema.index({ workspaceId: 1, documentId: 1, idx: 1 }, { unique: true });

export default mongoose.model<IDocumentChunk>('DocumentChunk', documentChunkSchema);
