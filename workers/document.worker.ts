import path from 'path';
import { promises as fs } from 'fs';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { embedBatch, isEmbeddingConfigured } from './services/embeddings.js';
import { parseFileAtUrl } from './pipeline/fileExtractor.js';

// Parallel schema definitions — workers don't import backend models.
// strict:false lets us read & write the full fields the backend owns.
const docSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Document: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Document'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Document', docSchema);

const chunkSchema = new mongoose.Schema({}, { strict: false, timestamps: { createdAt: true, updatedAt: false } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DocumentChunk: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['DocumentChunk'] as mongoose.Model<any> | undefined) ??
  mongoose.model('DocumentChunk', chunkSchema);

/**
 * Read a stored file off the local filesystem. Mirror of the backend
 * LocalFsStorage.read — workers don't share code with backend, so we
 * resolve paths via the same DOCUMENTS_STORAGE_PATH env the backend uses.
 */
async function readStoredFile(logicalPath: string): Promise<Buffer> {
  const root = path.resolve(env.DOCUMENTS_STORAGE_PATH);
  const normalized = path.posix.normalize(logicalPath).replace(/^\/+/, '');
  if (normalized.includes('..')) {
    throw new Error(`illegal storage path: ${logicalPath}`);
  }
  return fs.readFile(path.join(root, normalized));
}

async function processDocument(documentId: string, workspaceId: string): Promise<void> {
  // Cast ids to ObjectId explicitly — our parallel `strict: false`
  // schema gives Mongoose no way to know workspaceId should be cast,
  // so a string query won't match the ObjectId the backend stored.
  const docOid = new mongoose.Types.ObjectId(documentId);
  const wsOid = new mongoose.Types.ObjectId(workspaceId);

  // Use Model.updateOne for status writes, not doc.save(). Our parallel
  // schema is strict:false with no fields declared, so Mongoose's change
  // tracking on doc.save() silently skips assignments to unschematized
  // fields — the chunks got written, but the status updates never
  // persisted. updateOne bypasses change tracking entirely.
  const doc = (await Document.findOne({ _id: docOid, workspaceId: wsOid }).lean()) as
    | {
        _id: mongoose.Types.ObjectId;
        storagePath: string;
        originalFilename: string;
        fileType: string;
      }
    | null;
  if (!doc) {
    logger.warn('[document.worker] document not found', { documentId, workspaceId });
    return;
  }

  const setStatus = async (
    patch: Record<string, unknown>,
    unset?: Record<string, unknown>,
  ): Promise<void> => {
    const update: Record<string, unknown> = { $set: patch };
    if (unset && Object.keys(unset).length > 0) update['$unset'] = unset;
    await Document.updateOne({ _id: docOid }, update);
  };

  try {
    await setStatus({ status: 'parsing' });

    const buffer = await readStoredFile(doc.storagePath);

    const parsed = await parseLocalBuffer(doc.originalFilename, doc.fileType, buffer);
    if (!parsed) {
      throw new Error('parsing produced no content');
    }

    if (parsed.chunks.length === 0) {
      await setStatus({
        status: 'ready',
        chunkCount: 0,
        ...(parsed.pageCount !== undefined ? { pageCount: parsed.pageCount } : {}),
      });
      logger.warn('[document.worker] no chunks extracted', { documentId });
      return;
    }

    await setStatus({
      status: 'embedding',
      chunkCount: parsed.chunks.length,
      ...(parsed.pageCount !== undefined ? { pageCount: parsed.pageCount } : {}),
    });

    // Wipe any prior chunks for this document (e.g. if this is a retry).
    await DocumentChunk.deleteMany({ documentId: docOid });

    if (!isEmbeddingConfigured()) {
      logger.warn('[document.worker] embeddings not configured — storing chunks without vectors', {
        documentId,
      });
    }

    const vectors = await embedBatch(parsed.chunks.map((c) => c.text));

    const rows = parsed.chunks.map((chunk, i) => ({
      workspaceId: wsOid,
      documentId: docOid,
      idx: chunk.idx,
      text: chunk.text,
      pageHint: chunk.pageHint,
      embedding: vectors[i] ?? [],
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDims: vectors[i]?.length ?? 0,
    }));

    await DocumentChunk.insertMany(rows, { ordered: false });

    await setStatus({ status: 'ready' }, { errorMessage: '' });

    logger.info('[document.worker] processed', {
      documentId,
      fileType: parsed.fileType,
      chunks: parsed.chunks.length,
      embedded: vectors.filter(Boolean).length,
      ocr: parsed.usedOcr ?? false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[document.worker] processing failed', { documentId, err: msg });
    await setStatus({ status: 'failed', errorMessage: msg.slice(0, 2000) }).catch(() => {});
    throw err;
  }
}

/**
 * Mini-dispatcher that maps a filename + buffer to a ParsedFile. We
 * don't use parseFileAtUrl because that downloads via HTTP — we already
 * have the bytes. This keeps the hot path free of round-trips.
 */
async function parseLocalBuffer(
  filename: string,
  fileType: string,
  buffer: Buffer,
): Promise<Awaited<ReturnType<typeof parseFileAtUrl>> | null> {
  // The simplest implementation: save to a temp file-url scheme and let
  // parseFileAtUrl handle dispatch. But it includes network I/O. Instead
  // we rewrap fileExtractor's exported chunker indirectly by using the
  // URL-based API with a local file:// URL — fileExtractor treats
  // unknown schemes as fetch, which would fail. So we short-circuit by
  // re-implementing the format switch here. It's a few lines of glue
  // and avoids exporting every private parser from fileExtractor.
  //
  // Trade-off accepted: if fileExtractor gains a new format, we must
  // update the dispatch below too. Adding that format is a ~5 line
  // change so the coupling is cheap.
  const { extractPdfText } = await import('./pipeline/pdfParser.js');

  const CHUNK_SIZE = 2200;
  const CHUNK_OVERLAP = 200;
  const MAX_CHUNKS = 200;
  const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_REGEX = /\+?[\d][\d\s\-().]{6,18}[\d]/g;

  function chunkText(text: string, pageHint?: number): Array<{ idx: number; text: string; pageHint?: number }> {
    const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');
    if (clean.length <= CHUNK_SIZE) {
      return clean.trim()
        ? [{ idx: 0, text: clean.trim(), ...(pageHint !== undefined ? { pageHint } : {}) }]
        : [];
    }
    const chunks: Array<{ idx: number; text: string; pageHint?: number }> = [];
    let i = 0;
    let idx = 0;
    while (i < clean.length && idx < MAX_CHUNKS) {
      let end = Math.min(i + CHUNK_SIZE, clean.length);
      if (end < clean.length) {
        const tail = clean.slice(end - 200, end);
        const breakRel = Math.max(tail.lastIndexOf('\n\n'), tail.lastIndexOf('. '), tail.lastIndexOf('.\n'));
        if (breakRel > 0) end = end - 200 + breakRel + 1;
      }
      const slice = clean.slice(i, end).trim();
      if (slice) {
        chunks.push({ idx, text: slice, ...(pageHint !== undefined ? { pageHint } : {}) });
        idx += 1;
      }
      if (end >= clean.length) break;
      i = Math.max(end - CHUNK_OVERLAP, i + 1);
    }
    return chunks;
  }

  const emails = new Set<string>();
  const phones = new Set<string>();
  const extract = (t: string) => {
    (t.match(EMAIL_REGEX) ?? []).forEach((e) => emails.add(e));
    (t.match(PHONE_REGEX) ?? []).forEach((p) => phones.add(p));
  };

  let text = '';
  let pageCount: number | undefined;

  const ext = fileType.toLowerCase();
  if (ext === 'pdf') {
    const result = await extractPdfText(buffer);
    text = result.text ?? '';
    pageCount = result.pageCount;
  } else if (ext === 'docx' || ext === 'doc') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mammoth = (await import('mammoth')) as any;
    const result = await mammoth.extractRawText({ buffer });
    text = (result.value as string) ?? '';
  } else if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' }).slice(0, 500);
      for (const row of rows) {
        text += Object.values(row).join(' ') + '\n';
      }
    }
  } else if (ext === 'csv') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Papa = (await import('papaparse')).default as any;
    const parsed = Papa.parse(buffer.toString('utf8'), { header: true, skipEmptyLines: true });
    const rows = (parsed.data as Array<Record<string, string>>).slice(0, 2000);
    text = rows.map((r) => Object.values(r).join(' ')).join('\n');
  } else if (['mp3', 'm4a', 'wav', 'mp4', 'webm', 'ogg', 'aac', 'flac'].includes(ext)) {
    // Audio upload — push the Buffer straight to Whisper. The openai
    // SDK's toFile helper wraps a Buffer for multipart upload; Whisper
    // requires a recognizable extension on the filename, which we take
    // from the upload.
    const { default: OpenAI, toFile } = await import('openai');
    const apiKey = env.TRANSCRIPTION_API_KEY || env.EMBEDDING_API_KEY;
    if (!apiKey) {
      logger.warn('[document.worker] audio upload skipped — no TRANSCRIPTION/EMBEDDING API key');
      return null;
    }
    const cap = (env.TRANSCRIPTION_MAX_MB ?? 25) * 1024 * 1024;
    if (buffer.length > cap) {
      logger.warn('[document.worker] audio file exceeds Whisper cap', {
        filename,
        bytes: buffer.length,
        cap,
      });
      return null;
    }
    const client = new OpenAI({
      apiKey,
      baseURL: env.TRANSCRIPTION_BASE_URL || env.EMBEDDING_BASE_URL,
    });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const file = await toFile(buffer, safeName);
    const res = await client.audio.transcriptions.create({
      file,
      model: env.TRANSCRIPTION_MODEL,
      response_format: 'verbose_json',
    });
    const r = res as unknown as { text?: string };
    text = r.text ?? '';
  } else if (ext === 'html' || ext === 'htm') {
    const { load } = await import('cheerio');
    const $ = load(buffer.toString('utf8'));
    $('script, style, nav, footer, svg').remove();
    text = ($('body').text() || $.root().text()).replace(/\s+/g, ' ').trim();
  } else if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    text = buffer.toString('utf8');
  } else {
    logger.warn('[document.worker] unsupported file type', { filename, fileType });
    return null;
  }

  extract(text);
  const chunks = chunkText(text);

  const parsedFileType: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'html' | 'md' | 'audio' | 'unknown' =
    ext === 'doc' ? 'docx'
      : ext === 'xls' ? 'xlsx'
      : ext === 'htm' ? 'html'
      : ext === 'markdown' ? 'md'
      : ['mp3', 'm4a', 'wav', 'mp4', 'webm', 'ogg', 'aac', 'flac'].includes(ext) ? 'audio'
      : (['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md', 'html'].includes(ext)
        ? (ext as 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'md' | 'html')
        : 'unknown');

  return {
    url: `local://${filename}`,
    cacheKey: '',
    fileType: parsedFileType,
    bytes: buffer.length,
    pageCount,
    totalChars: text.length,
    chunks,
    emails: [...emails],
    phones: [...phones],
  };
}

export function createDocumentWorker(connection: Redis): Worker {
  const prefix = `{bull}:leadreai:${env.NODE_ENV}`;
  const worker = new Worker(
    'document-process',
    async (job: Job) => {
      const { documentId, workspaceId } = job.data as { documentId: string; workspaceId: string };
      logger.info('[document.worker] processing', { documentId, workspaceId });
      await processDocument(documentId, workspaceId);
    },
    {
      connection,
      prefix,
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error('[document.worker] job failed', { jobId: job?.id, err: err?.message });
  });
  worker.on('error', (err) => logger.error('[document.worker] error', { err: err.message }));

  return worker;
}
