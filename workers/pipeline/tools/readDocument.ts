import mongoose from 'mongoose';
import type { ToolDef } from './index.js';
import { cosineSimilarity, embedOne, isEmbeddingConfigured } from '../../services/embeddings.js';
import { logger } from '../../utils/logger.js';

/* ─────────────────────────────────────────────────────────────────
 * read_document — semantic search over the workspace's Library.
 *
 * The user uploads PDFs / spreadsheets / CSVs / docs to the Library;
 * the document.worker chunks + embeds each file. This tool embeds
 * the agent's query and returns the top-k matching chunks scored by
 * cosine similarity, scoped to the current workspace.
 *
 * Returns citation-ready hits: each has documentId, filename, chunk
 * idx, page hint (if known), and similarity score. The agent should
 * cite these when the user asks for "companies like the ones in my
 * portfolio doc" or wants facts grounded in their own uploads.
 * ───────────────────────────────────────────────────────────────── */

// Parallel Mongoose schemas — same pattern as document.worker.ts.
const chunkSchema = new mongoose.Schema({}, { strict: false, timestamps: { createdAt: true, updatedAt: false } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DocumentChunk: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['DocumentChunk'] as mongoose.Model<any> | undefined) ??
  mongoose.model('DocumentChunk', chunkSchema);

const docSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Document: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Document'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Document', docSchema);

// ProspectingJob handle for persisting citation events into the job's
// activityLog (so a refresh after the job finishes still shows which
// documents grounded the search).
const jobSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProspectingJob: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['ProspectingJob'] as mongoose.Model<any> | undefined) ??
  mongoose.model('ProspectingJob', jobSchema);

export const readDocumentTool: ToolDef = {
  name: 'read_document',
  description:
    "Search the user's uploaded Library (PDFs, spreadsheets, docs) for passages relevant to a query. Use FIRST for any query that references the user's own docs (pitch deck, portfolio list, case studies, ICP notes) or where their prior context should inform the research. Returns top chunks with citations (filename, chunk idx, page hint).",
  parametersSchema: '{"query": string, "limit"?: number}',
  handler: async (args, ctx) => {
    const query = String(args?.query ?? '').trim();
    if (!query) return { ok: false, output: 'query is required' };

    const limit = Math.min(20, Math.max(1, Math.floor(Number(args?.limit ?? 8)) || 8));

    if (!isEmbeddingConfigured()) {
      return {
        ok: true,
        output: JSON.stringify({
          hits: [],
          hint:
            'EMBEDDING_API_KEY is not configured on this deploy, so Library search is disabled. Uploaded documents are stored but not searchable until embeddings come online.',
        }),
      };
    }

    const queryVec = await embedOne(query);
    if (!queryVec || queryVec.length === 0) {
      return {
        ok: true,
        output: JSON.stringify({
          hits: [],
          hint: 'Could not embed the query (provider error). Try simpler keywords.',
        }),
      };
    }

    // Pull all chunks for this workspace. For a small library (tens
    // of docs) this is fast; when scale demands it, swap this for an
    // Atlas Vector Search $vectorSearch stage — the chunk shape is
    // already compatible.
    const chunks = (await DocumentChunk.find(
      {
        workspaceId: new mongoose.Types.ObjectId(ctx.workspaceId),
        embeddingDims: { $gt: 0 },
      },
      { documentId: 1, idx: 1, text: 1, pageHint: 1, embedding: 1 },
    )
      .limit(5000)
      .lean()) as unknown as Array<{
      documentId: mongoose.Types.ObjectId;
      idx: number;
      text: string;
      pageHint?: number;
      embedding: number[];
    }>;

    if (chunks.length === 0) {
      return {
        ok: true,
        output: JSON.stringify({
          hits: [],
          hint:
            'Your workspace Library is empty or none of the documents have finished embedding yet. Upload PDFs/docs/spreadsheets at /dashboard/library.',
        }),
      };
    }

    // Score + sort. For 5k chunks this is ~30ms — well under budget.
    const scored = chunks
      .map((c) => ({
        documentId: String(c.documentId),
        idx: c.idx,
        pageHint: c.pageHint,
        text: c.text,
        similarity: cosineSimilarity(queryVec, c.embedding ?? []),
      }))
      .filter((h) => h.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    // Fetch filenames for the hit documents in one round-trip.
    const docIds = [...new Set(scored.map((s) => s.documentId))];
    const docs = (await Document.find(
      { _id: { $in: docIds.map((id) => new mongoose.Types.ObjectId(id)) } },
      { originalFilename: 1, title: 1, fileType: 1 },
    ).lean()) as unknown as Array<{
      _id: mongoose.Types.ObjectId;
      originalFilename: string;
      title?: string;
      fileType: string;
    }>;
    const titleMap = new Map<string, { title: string; fileType: string }>(
      docs.map((d) => [String(d._id), { title: d.title || d.originalFilename, fileType: d.fileType }]),
    );

    const hits = scored.map((s) => ({
      documentId: s.documentId,
      documentTitle: titleMap.get(s.documentId)?.title ?? 'Untitled',
      fileType: titleMap.get(s.documentId)?.fileType ?? 'unknown',
      chunkIdx: s.idx,
      pageHint: s.pageHint,
      similarity: Math.round(s.similarity * 1000) / 1000,
      text: s.text.length > 800 ? s.text.slice(0, 800) + '…' : s.text,
    }));

    logger.debug('[readDocument] hits', {
      workspaceId: ctx.workspaceId,
      query: query.slice(0, 80),
      hitCount: hits.length,
      topSim: hits[0]?.similarity,
    });

    // Telemetry: publish a "library_citation" activity event so the live
    // dispatch card on the frontend can surface which documents grounded
    // this search. Aggregated by documentId — two chunks from the same
    // doc render as one pill showing the chunk count.
    if (hits.length > 0) {
      const byDoc = new Map<
        string,
        { documentId: string; title: string; fileType: string; chunks: number; topSimilarity: number }
      >();
      for (const h of hits) {
        const cur = byDoc.get(h.documentId);
        if (cur) {
          cur.chunks += 1;
          cur.topSimilarity = Math.max(cur.topSimilarity, h.similarity);
        } else {
          byDoc.set(h.documentId, {
            documentId: h.documentId,
            title: h.documentTitle,
            fileType: h.fileType,
            chunks: 1,
            topSimilarity: h.similarity,
          });
        }
      }
      const citations = [...byDoc.values()];
      const event = {
        type: 'activity',
        at: new Date().toISOString(),
        step: 'library_citation',
        message: `Read ${hits.length} passage${hits.length === 1 ? '' : 's'} from ${
          citations.length
        } library ${citations.length === 1 ? 'doc' : 'docs'}`,
        meta: { citations, query: query.slice(0, 200) },
      };
      ctx.publisher
        .publish(`job:progress:${ctx.jobId}`, JSON.stringify(event))
        .catch(() => {});

      // Persist to activityLog so a page refresh after the run still
      // surfaces the citation. Capped via $slice so long runs don't
      // balloon the doc.
      await ProspectingJob.findByIdAndUpdate(ctx.jobId, {
        $push: {
          activityLog: {
            $each: [
              {
                at: event.at,
                step: event.step,
                message: event.message,
                meta: event.meta,
              },
            ],
            $slice: -200,
          },
        },
      }).catch(() => {});
    }

    return {
      ok: true,
      output: JSON.stringify({ hits, queriedChunks: chunks.length }),
    };
  },
};
