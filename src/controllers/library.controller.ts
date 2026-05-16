import path from 'path';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import Document, { type DocumentStatus } from '../models/Document.js';
import DocumentChunk from '../models/DocumentChunk.js';
import Lead from '../models/Lead.js';
import ProspectingJob from '../models/ProspectingJob.js';
import FileModel from '../models/File.js';
import { buildDocumentStoragePath, getStorage } from '../services/storage/storage.js';
import { getDocumentQueue } from '../services/queue/queues.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from '../services/audit.js';
import { logger } from '../utils/logger.js';
import { generateText } from '../services/ai/aiProvider.js';

function isOid(v: unknown): v is string {
  return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
}

const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'mp4', 'webm', 'ogg', 'aac', 'flac'] as const;
const DOC_EXTS = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'txt', 'md', 'markdown', 'html', 'htm'] as const;

function detectFileTypeFromName(name: string): string {
  const ext = path.extname(name).replace('.', '').toLowerCase();
  if ((AUDIO_EXTS as readonly string[]).includes(ext)) return ext; // keep specific ext for worker dispatch
  if ((DOC_EXTS as readonly string[]).includes(ext)) return ext;
  return 'unknown';
}

export async function listDocuments(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50));

  const filter = { workspaceId };
  const [rows, total] = await Promise.all([
    Document.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Document.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: {
      data: rows.map((d) => ({
        _id: String(d._id),
        workspaceId: String(d.workspaceId),
        uploadedBy: String(d.uploadedBy),
        originalFilename: d.originalFilename,
        title: d.title,
        fileType: d.fileType,
        mimeType: d.mimeType,
        bytes: d.bytes,
        status: d.status,
        errorMessage: d.errorMessage,
        pageCount: d.pageCount,
        chunkCount: d.chunkCount,
        createdAt: d.createdAt?.toISOString?.() ?? String(d.createdAt),
        updatedAt: d.updatedAt?.toISOString?.() ?? String(d.updatedAt),
      })),
      total,
      page,
      limit,
    },
  });
}

export async function uploadDocument(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId } = req.params;

  // multer puts the parsed file on req.file
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) throw ApiError.badRequest('file is required');

  const originalFilename = file.originalname || 'upload';
  const fileType = detectFileTypeFromName(originalFilename);
  if (fileType === 'unknown') {
    throw ApiError.badRequest(
      'Unsupported file type. Supported: PDF · DOCX · XLSX · CSV · TXT · MD · HTML · MP3 · M4A · WAV · MP4 · WebM · OGG · AAC · FLAC',
    );
  }

  // Allocate doc id upfront so the logical path is stable.
  const docId = new mongoose.Types.ObjectId();
  const storagePath = buildDocumentStoragePath(
    String(workspaceId),
    String(docId),
    originalFilename,
  );

  await getStorage().write(storagePath, file.buffer);

  const doc = await Document.create({
    _id: docId,
    workspaceId: workspaceId!,
    uploadedBy: req.user._id,
    originalFilename,
    title: originalFilename,
    fileType,
    mimeType: file.mimetype,
    bytes: file.size,
    storagePath,
    status: 'pending' as DocumentStatus,
  });

  // Enqueue processing. Failures here don't break the upload — the
  // user can retry via the UI if the worker is down.
  try {
    await getDocumentQueue().add(
      'process',
      { documentId: String(doc._id), workspaceId: String(workspaceId) },
      { jobId: String(doc._id) },
    );
  } catch (err) {
    logger.warn('[library] enqueue failed', {
      documentId: String(doc._id),
      err: err instanceof Error ? err.message : String(err),
    });
  }

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'document.upload',
    resourceType: 'document',
    resourceId: String(doc._id),
    metadata: { filename: originalFilename, bytes: file.size },
  });

  res.status(201).json({
    success: true,
    data: {
      _id: String(doc._id),
      originalFilename,
      title: doc.title,
      fileType,
      bytes: file.size,
      status: doc.status,
    },
  });
}

export async function getDocument(req: Request, res: Response): Promise<void> {
  const { workspaceId, documentId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(documentId!)) {
    throw ApiError.badRequest('Invalid documentId');
  }
  const doc = await Document.findOne({ _id: documentId, workspaceId });
  if (!doc) throw ApiError.notFound('Document not found');
  res.json({ success: true, data: doc });
}

export async function updateDocument(req: Request, res: Response): Promise<void> {
  const { workspaceId, documentId } = req.params;
  if (!isOid(documentId)) throw ApiError.badRequest('Invalid documentId');

  const body = req.body as { title?: unknown };
  const setFields: Record<string, unknown> = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      throw ApiError.badRequest('title must be a non-empty string');
    }
    if (body.title.trim().length > 255) throw ApiError.badRequest('title too long');
    setFields['title'] = body.title.trim();
  }
  if (Object.keys(setFields).length === 0) throw ApiError.badRequest('No valid fields to update');

  const doc = await Document.findOneAndUpdate(
    { _id: documentId, workspaceId },
    { $set: setFields },
    { new: true },
  );
  if (!doc) throw ApiError.notFound('Document not found');
  res.json({ success: true, data: doc });
}

export async function retryDocument(req: Request, res: Response): Promise<void> {
  const { workspaceId, documentId } = req.params;
  if (!isOid(documentId)) throw ApiError.badRequest('Invalid documentId');

  const doc = await Document.findOne({ _id: documentId, workspaceId });
  if (!doc) throw ApiError.notFound('Document not found');

  await DocumentChunk.deleteMany({ documentId: doc._id, workspaceId }).catch(() => {});
  doc.status = 'pending';
  doc.errorMessage = undefined;
  doc.chunkCount = undefined;
  doc.pageCount = undefined;
  await doc.save();

  try {
    await getDocumentQueue().add(
      'process',
      { documentId: String(doc._id), workspaceId: String(workspaceId) },
      // Suffix makes the retry a distinct queue job — BullMQ dedups on
      // jobId, so reusing documentId would silently drop the retry.
      { jobId: `${String(doc._id)}-retry-${Date.now()}` },
    );
  } catch (err) {
    logger.warn('[library] retry enqueue failed', {
      documentId: String(doc._id),
      err: err instanceof Error ? err.message : String(err),
    });
  }

  res.json({ success: true, data: { status: doc.status } });
}

export async function listChunks(req: Request, res: Response): Promise<void> {
  const { workspaceId, documentId } = req.params;
  if (!isOid(documentId)) throw ApiError.badRequest('Invalid documentId');

  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50));

  const doc = await Document.findOne({ _id: documentId, workspaceId }).select('_id');
  if (!doc) throw ApiError.notFound('Document not found');

  const filter = { documentId: doc._id, workspaceId };
  const [rows, total] = await Promise.all([
    // Strip embeddings from the response — they're 6KB each and the UI
    // doesn't use them. List view stays in the 10s of KB instead of MBs.
    DocumentChunk.find(filter, { embedding: 0 })
      .sort({ idx: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    DocumentChunk.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: {
      data: rows.map((r) => ({
        _id: String(r._id),
        idx: r.idx,
        pageHint: r.pageHint,
        text: r.text,
        embeddingDims: r.embeddingDims,
      })),
      total,
      page,
      limit,
    },
  });
}

/**
 * Lift structured contact rows out of a CSV/XLSX library doc into
 * first-class Leads + a File. The mapping is best-effort: we scan
 * column headers for common patterns (email, company, name) and skip
 * any row without a plausible email. Email is the only hard
 * requirement — everything else degrades gracefully.
 *
 * A synthetic ProspectingJob is created so the Lead.jobId required
 * field has a valid parent, and the user gets a ledger entry for the
 * import on their Dispatches list.
 */
export async function docToFile(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, documentId } = req.params;
  if (!isOid(documentId)) throw ApiError.badRequest('Invalid documentId');

  const doc = await Document.findOne({ _id: documentId, workspaceId });
  if (!doc) throw ApiError.notFound('Document not found');

  if (doc.status !== 'ready') {
    throw ApiError.badRequest(`Document is ${doc.status}; wait for it to finish processing.`);
  }
  const supported = ['csv', 'xlsx', 'xls'];
  if (!supported.includes(doc.fileType)) {
    throw ApiError.badRequest(
      `Only CSV and XLSX files can be converted to a File. This is ${doc.fileType.toUpperCase()}.`,
    );
  }

  // Read the original bytes off storage and parse rows.
  let buffer: Buffer;
  try {
    buffer = await getStorage().read(doc.storagePath);
  } catch (err) {
    throw ApiError.badRequest(
      `Could not read stored file (it may have been moved): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const rawRows: Array<Record<string, unknown>> = [];
  if (doc.fileType === 'csv') {
    const parsed = Papa.parse<Record<string, unknown>>(buffer.toString('utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    rawRows.push(...((parsed.data ?? []) as Array<Record<string, unknown>>));
  } else {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      rawRows.push(
        ...XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' }),
      );
    }
  }

  if (rawRows.length === 0) {
    throw ApiError.badRequest('File has no rows to import.');
  }
  // Reasonable upper bound for one import.
  const cappedRows = rawRows.slice(0, 5000);

  // Column-name heuristic — find the first header matching each pattern.
  const headers = Object.keys(cappedRows[0] ?? {});
  const pickHeader = (patterns: RegExp[]): string | undefined => {
    for (const h of headers) {
      const lower = h.toLowerCase();
      if (patterns.some((p) => p.test(lower))) return h;
    }
    return undefined;
  };
  const emailCol = pickHeader([/\bemail\b/, /\be-?mail\b/]);
  const companyCol = pickHeader([/\bcompany\b/, /\borg(ani[sz]ation)?\b/, /\baccount\b/, /\bemployer\b/]);
  const nameCol = pickHeader([/\bfull[\s_]?name\b/, /^name$/, /\bcontact\b/]);
  const firstCol = pickHeader([/\bfirst[\s_]?name\b/]);
  const lastCol = pickHeader([/\blast[\s_]?name\b/, /\bsurname\b/]);
  const titleCol = pickHeader([/\btitle\b/, /\bjob[\s_]?title\b/, /\brole\b/, /\bposition\b/]);
  const phoneCol = pickHeader([/\bphone\b/, /\bmobile\b/, /\btel\b/]);
  const domainCol = pickHeader([/\bdomain\b/, /\bwebsite\b/, /\burl\b/]);

  if (!emailCol) {
    throw ApiError.badRequest(
      `No email column detected. Looked for headers matching /email/. Found: ${headers.join(', ')}`,
    );
  }

  const normalizeDomain = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    try {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      const withProto = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
      const { hostname } = new URL(withProto);
      return hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return undefined;
    }
  };

  // Create a synthetic "import" ProspectingJob so Lead.jobId has a parent
  // and the user sees the import in their Dispatches list.
  const importJob = await ProspectingJob.create({
    workspaceId: workspaceId!,
    createdBy: req.user._id,
    rawQuery: `Imported from ${doc.title ?? doc.originalFilename}`.slice(0, 500),
    parsedIntent: {
      queryType: 'manual_import',
      industry: null,
      desiredFields: [],
      outputSchema: [],
      targetCount: cappedRows.length,
      geography: {},
      personas: [],
    },
    status: 'complete',
    progress: {
      percentage: 100,
      currentStage: 'complete',
      stagesComplete: ['import'],
      leadsFoundSoFar: 0,
    },
    result: {
      totalLeadsFound: 0,
      totalAfterDedup: 0,
      dorkQueriesUsed: [],
      sourcesScraped: [doc.originalFilename],
      filesDownloaded: 1,
      durationMs: 0,
    },
    creditsCharged: 0,
    startedAt: new Date(),
    completedAt: new Date(),
  });

  const wsOid = new mongoose.Types.ObjectId(String(workspaceId));
  const jobOid = importJob._id as mongoose.Types.ObjectId;

  // Walk rows → candidate Lead shapes. Dedup by email within the batch.
  const seenEmails = new Set<string>();
  const leadDocs: Array<Record<string, unknown>> = [];
  let skippedNoEmail = 0;
  let skippedDuplicate = 0;

  for (const row of cappedRows) {
    const email = String((row[emailCol] ?? '') as string).trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skippedNoEmail += 1;
      continue;
    }
    if (seenEmails.has(email)) {
      skippedDuplicate += 1;
      continue;
    }
    seenEmails.add(email);

    const domainFromCol = domainCol ? normalizeDomain(String(row[domainCol] ?? '')) : undefined;
    const domainFromEmail = email.split('@')[1]?.toLowerCase();
    const companyDomain = domainFromCol ?? domainFromEmail;

    const firstName = firstCol ? String(row[firstCol] ?? '').trim() : '';
    const lastName = lastCol ? String(row[lastCol] ?? '').trim() : '';
    const fullNameFromParts = `${firstName} ${lastName}`.trim();
    const fullName = nameCol
      ? String(row[nameCol] ?? '').trim() || fullNameFromParts
      : fullNameFromParts;

    const companyRaw = companyCol ? String(row[companyCol] ?? '').trim() : '';
    const companyName = companyRaw || companyDomain || email.split('@')[0] || 'Unknown';
    const title = titleCol ? String(row[titleCol] ?? '').trim() : '';
    const phoneRaw = phoneCol ? String(row[phoneCol] ?? '').trim() : '';

    const leadDoc: Record<string, unknown> = {
      workspaceId: wsOid,
      jobId: jobOid,
      companyName,
      companyDomain,
      emails: [
        {
          address: email,
          type: 'business',
          confidence: 0.9,
          verified: false,
          source: 'user_import',
        },
      ],
      phones: phoneRaw
        ? [{ raw: phoneRaw, source: 'user_import' }]
        : [],
      sources: [
        {
          url: `library://${String(doc._id)}`,
          type: 'scraped_page',
          scrapedAt: new Date(),
          confidence: 0.9,
        },
      ],
      tags: ['library_import'],
      rankScore: 70,
      isDuplicate: false,
      contactSummary: fullName
        ? {
            totalContacts: 1,
            topContact: {
              fullName,
              title,
              seniority: '',
            },
          }
        : undefined,
    };

    leadDocs.push(leadDoc);
  }

  if (leadDocs.length === 0) {
    // Clean up the synthetic job since we have nothing to file.
    await ProspectingJob.deleteOne({ _id: importJob._id }).catch(() => {});
    throw ApiError.badRequest(
      `No valid rows found. Email column '${emailCol}' was present but every row either missed it or had an invalid address.`,
    );
  }

  // ordered:false so a single bad row doesn't abort the rest. The
  // workspaceId+companyDomain unique index may collide with existing
  // rows — we swallow 11000 and continue.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let insertedIds: mongoose.Types.ObjectId[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inserted = (await Lead.insertMany(leadDocs as any[], {
      ordered: false,
    })) as unknown as Array<{ _id: mongoose.Types.ObjectId }>;
    insertedIds = inserted.map((l) => l._id);
  } catch (err: unknown) {
    const bulkErr = err as { insertedDocs?: Array<{ _id: mongoose.Types.ObjectId }>; writeErrors?: unknown[]; code?: number };
    if (bulkErr.insertedDocs) {
      insertedIds = bulkErr.insertedDocs.map((d) => d._id);
    }
    const failedCount = Array.isArray(bulkErr.writeErrors) ? bulkErr.writeErrors.length : 0;
    logger.warn('[library.toFile] partial insert', {
      documentId: String(doc._id),
      inserted: insertedIds.length,
      failed: failedCount,
    });
  }

  // Update the synthetic job's result with the actual counts.
  await ProspectingJob.updateOne(
    { _id: importJob._id },
    {
      $set: {
        'progress.leadsFoundSoFar': insertedIds.length,
        'result.totalLeadsFound': insertedIds.length,
        'result.totalAfterDedup': insertedIds.length,
      },
    },
  ).catch(() => {});

  const file = await FileModel.create({
    workspaceId: wsOid,
    createdBy: req.user._id,
    name: (doc.title ?? doc.originalFilename).slice(0, 200),
    description: `Imported from the Library — ${doc.originalFilename}`,
    source: 'job',
    sourceJobId: importJob._id,
    leadIds: insertedIds,
  });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'document.to_file',
    resourceType: 'document',
    resourceId: String(doc._id),
    metadata: {
      fileId: String(file._id),
      importJobId: String(importJob._id),
      leadCount: insertedIds.length,
      skippedNoEmail,
      skippedDuplicate,
    },
  });

  logger.info('[library.toFile] complete', {
    documentId: String(doc._id),
    fileId: String(file._id),
    leads: insertedIds.length,
  });

  res.status(201).json({
    success: true,
    data: {
      fileId: String(file._id),
      importJobId: String(importJob._id),
      leadCount: insertedIds.length,
      skippedNoEmail,
      skippedDuplicate,
      detectedColumns: {
        email: emailCol,
        company: companyCol ?? null,
        name: nameCol ?? null,
        firstName: firstCol ?? null,
        lastName: lastCol ?? null,
        title: titleCol ?? null,
        phone: phoneCol ?? null,
        domain: domainCol ?? null,
      },
    },
  });
}

/* ───────────────────────────────────────────────────────────────
 * Analyze — the "tell me what you understand" step.
 *
 * Pulls up to ~15 chunks (≈30KB of text), sends them to the LLM with
 * a structured prompt, and gets back:
 *   · docType: a classification ("pitch deck" / "ICP doc" / etc.)
 *   · summary: 1-2 sentence gist
 *   · keyEntities: industries / geographies / personas / companies
 *   · proposedDispatches: prompt cards the user can file directly
 *   · ambiguities: things the user should clarify before dispatching
 *
 * Cached on the Document doc itself (`meta.analysis`), so repeat calls
 * cost nothing. `?refresh=true` forces a re-run. Response shape is
 * stable so the frontend doesn't care whether it's cached or fresh.
 * ─────────────────────────────────────────────────────────────── */

interface DocAnalysis {
  docType: string;
  summary: string;
  keyEntities: {
    industries: string[];
    geographies: string[];
    personas: string[];
    companies: string[];
  };
  proposedDispatches: Array<{
    prompt: string;
    rationale: string;
    targetCount?: number;
  }>;
  ambiguities: string[];
  model?: string;
  generatedAt?: string;
}

function buildAnalysisPrompt(docTitle: string, combinedText: string): string {
  return [
    `You are a B2B sales-research analyst. The user has uploaded a document titled "${docTitle}".`,
    '',
    'Read the content below and return a JSON object matching this EXACT shape (no prose, no markdown, just the raw JSON object):',
    '',
    '{',
    '  "docType": string,                           // e.g. "ICP profile", "pitch deck", "portfolio list", "case study", "CRM export"',
    '  "summary": string,                           // 1-2 sentences describing what this doc is and who it describes',
    '  "keyEntities": {',
    '    "industries": string[],                    // industries/verticals named in the doc',
    '    "geographies": string[],                   // countries, regions, cities',
    '    "personas": string[],                      // job titles or buyer roles named',
    '    "companies": string[]                      // specific company names (up to 20)',
    '  },',
    '  "proposedDispatches": [                      // 3 distinct prospecting prompts the user could run from this doc',
    '    { "prompt": string, "rationale": string, "targetCount": number },',
    '    …',
    '  ],',
    '  "ambiguities": string[]                      // questions you\'d ask the user to sharpen targeting — zero or more',
    '}',
    '',
    'Rules:',
    '- Each proposedDispatch.prompt should be a FULL natural-language query the user could paste into a prospecting tool. Name specific industries, geographies, and personas derived from the doc. Aim for 20-50 target leads per prompt.',
    '- Make the 3 proposals genuinely different — don\'t give variations of the same idea.',
    '- Only list entities actually present in the doc. If the doc says nothing about geography, return an empty array — do not guess.',
    '- Keep summary specific and concrete. Avoid marketing language.',
    '- Return ONLY the JSON. No code fences, no preamble.',
    '',
    '---DOCUMENT CONTENT START---',
    combinedText,
    '---DOCUMENT CONTENT END---',
  ].join('\n');
}

function safeParseAnalysis(text: string): DocAnalysis | null {
  // LLMs sometimes wrap JSON in ```json fences despite instructions.
  // Strip them, then find the outermost {...} block.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = stripped.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as Partial<DocAnalysis>;
    if (
      typeof parsed.docType !== 'string' ||
      typeof parsed.summary !== 'string' ||
      !parsed.keyEntities ||
      !Array.isArray(parsed.proposedDispatches)
    ) {
      return null;
    }
    return {
      docType: parsed.docType,
      summary: parsed.summary,
      keyEntities: {
        industries: Array.isArray(parsed.keyEntities.industries) ? parsed.keyEntities.industries.slice(0, 20) : [],
        geographies: Array.isArray(parsed.keyEntities.geographies) ? parsed.keyEntities.geographies.slice(0, 20) : [],
        personas: Array.isArray(parsed.keyEntities.personas) ? parsed.keyEntities.personas.slice(0, 20) : [],
        companies: Array.isArray(parsed.keyEntities.companies) ? parsed.keyEntities.companies.slice(0, 20) : [],
      },
      proposedDispatches: parsed.proposedDispatches
        .filter((d) => d && typeof d.prompt === 'string' && d.prompt.trim())
        .slice(0, 5)
        .map((d) => ({
          prompt: String(d.prompt).trim().slice(0, 800),
          rationale: typeof d.rationale === 'string' ? d.rationale.slice(0, 400) : '',
          ...(Number.isFinite(Number(d.targetCount))
            ? { targetCount: Math.max(1, Math.min(200, Math.floor(Number(d.targetCount)))) }
            : {}),
        })),
      ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities.slice(0, 10) : [],
    };
  } catch {
    return null;
  }
}

export async function analyzeDocument(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, documentId } = req.params;
  if (!isOid(documentId)) throw ApiError.badRequest('Invalid documentId');

  const refresh = String(req.query['refresh'] ?? '') === 'true';

  const doc = await Document.findOne({ _id: documentId, workspaceId });
  if (!doc) throw ApiError.notFound('Document not found');
  if (doc.status !== 'ready') {
    throw ApiError.badRequest(`Document is ${doc.status}; wait for it to finish processing.`);
  }

  const existing = (doc.meta as { analysis?: DocAnalysis } | undefined)?.analysis;
  if (!refresh && existing && existing.proposedDispatches?.length > 0) {
    res.json({ success: true, data: { ...existing, cached: true } });
    return;
  }

  const chunks = await DocumentChunk.find({ documentId: doc._id, workspaceId })
    .sort({ idx: 1 })
    .limit(15)
    .select('text')
    .lean();

  if (chunks.length === 0) {
    throw ApiError.badRequest(
      'Document has no extracted chunks — can\'t analyze. Try Retry processing first.',
    );
  }

  const combined = chunks
    .map((c) => (c as { text: string }).text)
    .join('\n\n')
    .slice(0, 32000);

  const docTitle = doc.title ?? doc.originalFilename;

  let analysis: DocAnalysis | null = null;
  let model = '';
  try {
    const resp = await generateText(
      [{ role: 'user', content: buildAnalysisPrompt(docTitle, combined) }],
      { maxTokens: 1800 },
    );
    model = resp.provider;
    analysis = safeParseAnalysis(resp.text);
    if (!analysis) {
      logger.warn('[library.analyze] LLM returned unparseable JSON', {
        documentId: String(doc._id),
        preview: resp.text.slice(0, 280),
      });
      throw ApiError.badRequest(
        'The model returned an unparseable response. Try again or set a stronger chat model.',
      );
    }
  } catch (err) {
    logger.error('[library.analyze] failed', {
      documentId: String(doc._id),
      err: err instanceof Error ? err.message : String(err),
    });
    throw err instanceof ApiError
      ? err
      : ApiError.badRequest(
          `LLM call failed: ${err instanceof Error ? err.message : 'unknown error'}. Check chat-model env.`,
        );
  }

  analysis.model = model;
  analysis.generatedAt = new Date().toISOString();

  await Document.updateOne(
    { _id: doc._id },
    { $set: { 'meta.analysis': analysis } },
  ).catch(() => {});

  res.json({ success: true, data: { ...analysis, cached: false } });
}

export async function deleteDocument(req: Request, res: Response): Promise<void> {
  const { workspaceId, documentId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(documentId!)) {
    throw ApiError.badRequest('Invalid documentId');
  }
  const doc = await Document.findOne({ _id: documentId, workspaceId });
  if (!doc) throw ApiError.notFound('Document not found');

  // Best-effort: remove chunks first, then the file, then the doc row.
  await DocumentChunk.deleteMany({ documentId: doc._id, workspaceId }).catch(() => {});
  await getStorage().remove(doc.storagePath).catch(() => {});
  await Document.deleteOne({ _id: doc._id });

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'document.delete',
    resourceType: 'document',
    resourceId: String(doc._id),
    metadata: { filename: doc.originalFilename },
  });

  res.json({ success: true });
}
