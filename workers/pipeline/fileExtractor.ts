import axios from 'axios';
import type { AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { load as cheerioLoad } from 'cheerio';
import Papa from 'papaparse';
import { chromium } from 'playwright';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { cacheKeyForUrl, getCachedFile, setCachedFile } from '../services/fileCache.js';
import { recordFileFetchCost } from '../services/costTracker.js';
import { transcribeUrl } from '../services/transcription.js';
import { extractPdfText } from './pdfParser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileType = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'html' | 'md' | 'audio' | 'unknown';

export interface FileChunk {
  idx: number;
  text: string;
  /** 1-based page number, only set for PDFs. */
  pageHint?: number;
}

export interface FileTable {
  sheet?: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  truncatedTo?: number;
}

export interface ParsedFile {
  url: string;
  cacheKey: string;
  fileType: FileType;
  bytes: number;
  pageCount?: number;
  totalChars: number;
  /** Chunks are roughly CHUNK_SIZE chars with CHUNK_OVERLAP overlap. */
  chunks: FileChunk[];
  /** Present for XLSX/CSV (structured) or PDF tables if we ever extract them. */
  tables?: FileTable[];
  emails: string[];
  phones: string[];
  meta?: Record<string, unknown>;
  /** True when we had to fall back to OCR (scanned PDF etc.). */
  usedOcr?: boolean;
}

/**
 * Legacy shape kept so the older contactEnricher path still compiles.
 * New callers should use ParsedFile.
 */
export interface ExtractedFileData {
  url: string;
  fileType: 'pdf' | 'docx' | 'xlsx' | 'unknown';
  emails: string[];
  phones: string[];
  rows?: Array<Record<string, string>>;
  textSnippet: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /\+?[\d][\d\s\-().]{6,18}[\d]/g;
const MAX_BYTES = env.MAX_FILE_DOWNLOAD_SIZE_MB * 1024 * 1024;

const CHUNK_SIZE = 2200;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS = 200; // hard cap so a 500-page dump doesn't explode memory

// When a PDF's extracted text is this thin relative to its bytes, treat
// it as a scanned doc and fall back to OCR.
const OCR_TRIGGER_RATIO = 0.0008;
// Skip OCR entirely on files larger than this — tesseract.js on a 50MB
// scanned PDF would run forever.
const OCR_MAX_BYTES = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const client = axios.create({ responseType: 'arraybuffer', timeout: 30000 });
axiosRetry(client, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error: AxiosError) => {
    const status = error.response?.status;
    if (status !== undefined && status < 500) return false;
    return axiosRetry.isNetworkOrIdempotentRequestError(error);
  },
});

const CHROME_LIKE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function refererHeadersForUrl(fileUrl: string): Record<string, string> {
  try {
    const u = new URL(fileUrl);
    const origin = u.origin;
    return {
      'User-Agent': CHROME_LIKE_UA,
      Referer: `${origin}/`,
      Origin: origin,
      'Accept-Language': 'en-US,en;q=0.9',
    };
  } catch {
    return { 'User-Agent': CHROME_LIKE_UA, 'Accept-Language': 'en-US,en;q=0.9' };
  }
}

function acceptHeaderForType(fileType: FileType): string {
  switch (fileType) {
    case 'pdf':
      return 'application/pdf,application/octet-stream,*/*;q=0.8';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/octet-stream,*/*;q=0.8';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*;q=0.8';
    case 'csv':
      return 'text/csv,application/octet-stream,*/*;q=0.8';
    case 'txt':
    case 'md':
      return 'text/plain,*/*;q=0.8';
    case 'html':
      return 'text/html,application/xhtml+xml,*/*;q=0.8';
    default:
      return '*/*';
  }
}

async function downloadFileViaPlaywright(url: string, fileType: FileType): Promise<Buffer | null> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: env.PLAYWRIGHT_HEADLESS });
    const context = await browser.newContext({ userAgent: CHROME_LIKE_UA, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      /* invalid url */
    }
    if (origin) {
      await page
        .goto(origin, { timeout: Math.min(env.PLAYWRIGHT_TIMEOUT_MS, 25_000), waitUntil: 'domcontentloaded' })
        .catch(() => {});
    }
    const response = await page.goto(url, {
      timeout: Math.min(env.PLAYWRIGHT_TIMEOUT_MS, 45_000),
      waitUntil: 'commit',
    });
    if (!response) return null;
    const status = response.status();
    if (status < 200 || status >= 300) return null;
    const buf = Buffer.from(await response.body());
    if (buf.length > MAX_BYTES) return null;
    logger.info('[fileExtractor] playwright fetched', { url, fileType, bytes: buf.length });
    return buf;
  } catch (err) {
    logger.warn('[fileExtractor] playwright fetch failed', {
      url,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await browser?.close();
  }
}

// ---------------------------------------------------------------------------
// Type sniffing
// ---------------------------------------------------------------------------

function detectTypeFromMagic(buf: Buffer): FileType | null {
  if (buf.length < 4) return null;
  // PDF: "%PDF"
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
  // ZIP family (DOCX / XLSX / PPTX): "PK\x03\x04"
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return null; // needs further sniffing by caller
  return null;
}

function detectTypeFromContentType(ct: string | undefined): FileType | null {
  if (!ct) return null;
  const lower = ct.toLowerCase();
  if (lower.includes('application/pdf')) return 'pdf';
  if (lower.includes('officedocument.wordprocessingml')) return 'docx';
  if (lower.includes('officedocument.spreadsheetml')) return 'xlsx';
  if (lower.includes('text/csv') || lower.includes('application/csv')) return 'csv';
  if (lower.includes('text/html') || lower.includes('application/xhtml')) return 'html';
  if (lower.includes('text/markdown')) return 'md';
  if (lower.startsWith('text/')) return 'txt';
  if (lower.startsWith('audio/') || lower.startsWith('video/') || lower === 'application/ogg') return 'audio';
  return null;
}

function detectTypeFromExtension(url: string): FileType {
  const ext = (url.split('?')[0] ?? '').split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'pdf':
      return 'pdf';
    case 'docx':
    case 'doc':
      return 'docx';
    case 'xlsx':
    case 'xls':
      return 'xlsx';
    case 'csv':
      return 'csv';
    case 'txt':
      return 'txt';
    case 'md':
    case 'markdown':
      return 'md';
    case 'html':
    case 'htm':
      return 'html';
    case 'mp3':
    case 'm4a':
    case 'wav':
    case 'ogg':
    case 'flac':
    case 'aac':
    case 'mp4':
    case 'webm':
      return 'audio';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Chunking + shared helpers
// ---------------------------------------------------------------------------

function chunkText(text: string, pageHint?: number): FileChunk[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');
  if (clean.length <= CHUNK_SIZE) {
    return clean.trim()
      ? [{ idx: 0, text: clean.trim(), ...(pageHint !== undefined ? { pageHint } : {}) }]
      : [];
  }
  const chunks: FileChunk[] = [];
  let i = 0;
  let idx = 0;
  while (i < clean.length && idx < MAX_CHUNKS) {
    let end = Math.min(i + CHUNK_SIZE, clean.length);
    // Prefer to break at a paragraph/sentence boundary within the last
    // 200 chars of the window — keeps chunks coherent.
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

function extractEmailsPhones(text: string): { emails: string[]; phones: string[] } {
  return {
    emails: [...new Set<string>(text.match(EMAIL_REGEX) ?? [])],
    phones: [...new Set<string>(text.match(PHONE_REGEX) ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Format-specific parsers
// ---------------------------------------------------------------------------

async function parsePdf(url: string, buffer: Buffer): Promise<ParsedFile> {
  const result = await extractPdfText(buffer);
  let text = result.text ?? '';
  const pageCount = result.pageCount;
  let usedOcr = false;

  // If the extracted text looks suspiciously thin for the file size,
  // assume this is a scanned PDF and OCR it.
  const ratio = text.trim().length / Math.max(buffer.length, 1);
  if (ratio < OCR_TRIGGER_RATIO && buffer.length < OCR_MAX_BYTES) {
    logger.info('[fileExtractor] PDF text sparse, trying OCR', {
      url,
      bytes: buffer.length,
      extractedChars: text.trim().length,
    });
    const ocred = await ocrPdfBuffer(buffer).catch((err: unknown) => {
      logger.warn('[fileExtractor] OCR failed', {
        url,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (ocred && ocred.length > text.length) {
      text = ocred;
      usedOcr = true;
    }
  }

  const { emails, phones } = extractEmailsPhones(text);
  const chunks = chunkText(text);

  return {
    url,
    cacheKey: cacheKeyForUrl(url),
    fileType: 'pdf',
    bytes: buffer.length,
    pageCount,
    totalChars: text.length,
    chunks,
    emails,
    phones,
    usedOcr,
  };
}

async function parseDocx(url: string, buffer: Buffer): Promise<ParsedFile> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth = (await import('mammoth')) as any;
  const result = await mammoth.extractRawText({ buffer });
  const text = (result.value as string) ?? '';
  const { emails, phones } = extractEmailsPhones(text);
  return {
    url,
    cacheKey: cacheKeyForUrl(url),
    fileType: 'docx',
    bytes: buffer.length,
    totalChars: text.length,
    chunks: chunkText(text),
    emails,
    phones,
  };
}

async function parseXlsx(url: string, buffer: Buffer): Promise<ParsedFile> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const emails: string[] = [];
  const phones: string[] = [];
  const tables: FileTable[] = [];
  let combinedText = '';

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (jsonRows.length === 0) continue;

    const headers = Object.keys(jsonRows[0] ?? {});
    const cappedRows = jsonRows.slice(0, 500).map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])),
    );
    tables.push({
      sheet: sheetName,
      headers,
      rows: cappedRows,
      truncatedTo: jsonRows.length > 500 ? 500 : undefined,
    });

    for (const row of cappedRows) {
      const rowText = Object.values(row).join(' ');
      combinedText += rowText + '\n';
      emails.push(...(rowText.match(EMAIL_REGEX) ?? []));
      phones.push(...(rowText.match(PHONE_REGEX) ?? []));
    }
  }

  return {
    url,
    cacheKey: cacheKeyForUrl(url),
    fileType: 'xlsx',
    bytes: buffer.length,
    totalChars: combinedText.length,
    chunks: chunkText(combinedText),
    tables,
    emails: [...new Set(emails)],
    phones: [...new Set(phones)],
  };
}

async function parseCsv(url: string, buffer: Buffer): Promise<ParsedFile> {
  const raw = buffer.toString('utf8');
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  const rows = (parsed.data ?? []).slice(0, 2000);
  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const combinedText = rows
    .map((r) => Object.values(r).join(' '))
    .join('\n');
  const { emails, phones } = extractEmailsPhones(combinedText);
  return {
    url,
    cacheKey: cacheKeyForUrl(url),
    fileType: 'csv',
    bytes: buffer.length,
    totalChars: combinedText.length,
    chunks: chunkText(combinedText),
    tables: [
      {
        headers,
        rows: rows.map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])),
        ),
        truncatedTo: (parsed.data?.length ?? 0) > 2000 ? 2000 : undefined,
      },
    ],
    emails,
    phones,
  };
}

async function parseHtml(url: string, buffer: Buffer): Promise<ParsedFile> {
  const html = buffer.toString('utf8');
  const $ = cheerioLoad(html);
  $('script, style, nav, footer, svg').remove();
  const text = ($('body').text() || $.root().text()).replace(/\s+/g, ' ').trim();
  const { emails, phones } = extractEmailsPhones(text);
  return {
    url,
    cacheKey: cacheKeyForUrl(url),
    fileType: 'html',
    bytes: buffer.length,
    totalChars: text.length,
    chunks: chunkText(text),
    emails,
    phones,
  };
}

/**
 * For audio/video URLs we don't parse a local buffer — Whisper takes
 * the URL, downloads it internally, transcribes, returns text. We
 * still hand back a ParsedFile so `fetch_file` and `get_file_chunk`
 * can treat transcripts identically to PDFs.
 *
 * `bufferBytes` is the pre-downloaded size from the main download
 * path; we skip using the buffer itself since transcribeUrl does its
 * own fetch. A future refactor could share the buffer to avoid the
 * double-download, at the cost of additional complexity in the
 * transcription client.
 */
async function parseAudio(url: string, bufferBytes: number): Promise<ParsedFile | null> {
  const result = await transcribeUrl(url);
  if (!result) return null;
  const { emails, phones } = extractEmailsPhones(result.text);
  return {
    url,
    cacheKey: cacheKeyForUrl(url),
    fileType: 'audio',
    bytes: result.bytes || bufferBytes,
    totalChars: result.text.length,
    chunks: chunkText(result.text),
    emails,
    phones,
    meta: {
      durationSeconds: result.durationSeconds,
      language: result.language,
      mimeType: result.mimeType,
    },
  };
}

async function parsePlain(url: string, buffer: Buffer, fileType: 'txt' | 'md'): Promise<ParsedFile> {
  const text = buffer.toString('utf8');
  const { emails, phones } = extractEmailsPhones(text);
  return {
    url,
    cacheKey: cacheKeyForUrl(url),
    fileType,
    bytes: buffer.length,
    totalChars: text.length,
    chunks: chunkText(text),
    emails,
    phones,
  };
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

/**
 * OCR a PDF by lazy-loading tesseract.js and letting it read the PDF
 * as a single image stream. This is slow (5-60s per small file) —
 * gated by OCR_TRIGGER_RATIO so we only pay the cost when text
 * extraction truly failed.
 *
 * Wrapped in dynamic import so a missing tesseract install or
 * broken WASM doesn't crash the worker at startup.
 */
async function ocrPdfBuffer(buffer: Buffer): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tesseract = (await import('tesseract.js')) as any;
    const worker = await tesseract.createWorker('eng');
    try {
      const { data } = await worker.recognize(buffer);
      return typeof data?.text === 'string' ? data.text : null;
    } finally {
      await worker.terminate().catch(() => {});
    }
  } catch (err) {
    logger.warn('[fileExtractor] tesseract failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: parseFileAtUrl
// ---------------------------------------------------------------------------

/**
 * Download (with cache) + parse a file at a URL. Returns a ParsedFile
 * with chunked text, extracted tables, and contact hints. Cached
 * in Redis for 24h.
 */
export async function parseFileAtUrl(url: string): Promise<ParsedFile | null> {
  const cached = await getCachedFile<ParsedFile>(url);
  if (cached) {
    logger.debug('[fileExtractor] cache hit', { url, fileType: cached.fileType });
    return cached;
  }

  const hintedType = detectTypeFromExtension(url);
  const baseHeaders = {
    ...refererHeadersForUrl(url),
    Accept: acceptHeaderForType(hintedType),
  };

  // Audio path: do a lightweight HEAD to classify, then delegate to the
  // transcription service which does its own download + Whisper call.
  // This avoids a double-download (our download here + Whisper's).
  if (hintedType === 'audio') {
    try {
      const head = await axios.head(url, {
        timeout: 10_000,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      const headBytes = Number(head.headers['content-length']) || 0;
      const parsed = await parseAudio(url, headBytes);
      if (parsed) {
        await setCachedFile(url, parsed);
        void recordFileFetchCost('audio', parsed.bytes ?? headBytes);
        logger.info('[fileExtractor] transcribed', {
          url,
          chars: parsed.totalChars,
          chunks: parsed.chunks.length,
          durationSeconds: (parsed.meta?.['durationSeconds'] as number | undefined) ?? undefined,
        });
        return parsed;
      }
      return null;
    } catch (err) {
      logger.warn('[fileExtractor] audio dispatch failed', {
        url,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  let buffer: Buffer | null = null;
  let contentType: string | undefined;
  try {
    const response = await client.get<ArrayBuffer>(url, {
      headers: baseHeaders,
      maxContentLength: MAX_BYTES,
    });
    buffer = Buffer.from(response.data);
    contentType = (response.headers['content-type'] as string | undefined) ?? undefined;
  } catch (firstErr) {
    const status = (firstErr as AxiosError).response?.status;
    if (status === undefined || status >= 400) {
      // Some types (pdf/docx/xlsx) benefit from the Playwright fallback;
      // plain-text types rarely do, so don't waste the launch.
      if (hintedType === 'pdf' || hintedType === 'docx' || hintedType === 'xlsx') {
        buffer = await downloadFileViaPlaywright(url, hintedType);
      }
    }
    if (!buffer) {
      logger.warn('[fileExtractor] fetch failed', {
        url,
        err: firstErr instanceof Error ? firstErr.message : String(firstErr),
      });
      return null;
    }
  }

  // Prefer header-based detection, then magic bytes, then extension.
  const detectedType =
    detectTypeFromContentType(contentType) ??
    detectTypeFromMagic(buffer) ??
    (hintedType === 'unknown' ? null : hintedType);

  if (!detectedType || detectedType === 'unknown') {
    logger.warn('[fileExtractor] could not detect file type', { url, contentType, hint: hintedType });
    return null;
  }

  let parsed: ParsedFile;
  try {
    switch (detectedType) {
      case 'pdf':
        parsed = await parsePdf(url, buffer);
        break;
      case 'docx':
        parsed = await parseDocx(url, buffer);
        break;
      case 'xlsx':
        parsed = await parseXlsx(url, buffer);
        break;
      case 'csv':
        parsed = await parseCsv(url, buffer);
        break;
      case 'html':
        parsed = await parseHtml(url, buffer);
        break;
      case 'md':
      case 'txt':
        parsed = await parsePlain(url, buffer, detectedType);
        break;
      default:
        return null;
    }
  } catch (err) {
    logger.warn('[fileExtractor] parse failed', {
      url,
      fileType: detectedType,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  await setCachedFile(url, parsed);
  void recordFileFetchCost(parsed.fileType ?? 'unknown', parsed.bytes);
  logger.info('[fileExtractor] parsed', {
    url,
    fileType: parsed.fileType,
    bytes: parsed.bytes,
    chunks: parsed.chunks.length,
    emails: parsed.emails.length,
    phones: parsed.phones.length,
    ocr: parsed.usedOcr,
  });
  return parsed;
}

// ---------------------------------------------------------------------------
// Legacy shim — keep the older ExtractedFileData shape working.
// ---------------------------------------------------------------------------

export async function runFileExtractor(fileUrls: string[]): Promise<ExtractedFileData[]> {
  const uniqueUrls = [...new Set(fileUrls.map((u) => u.trim()).filter(Boolean))];
  const results: ExtractedFileData[] = [];
  for (const url of uniqueUrls) {
    const parsed = await parseFileAtUrl(url).catch(() => null);
    if (!parsed) continue;
    // Down-cast ParsedFile.fileType to the legacy union.
    const legacyType: ExtractedFileData['fileType'] =
      parsed.fileType === 'pdf' || parsed.fileType === 'docx' || parsed.fileType === 'xlsx'
        ? parsed.fileType
        : 'unknown';
    const firstTable = parsed.tables?.[0];
    results.push({
      url: parsed.url,
      fileType: legacyType,
      emails: parsed.emails,
      phones: parsed.phones,
      rows: firstTable?.rows,
      textSnippet: parsed.chunks[0]?.text?.slice(0, 1000) ?? '',
    });
  }
  logger.info('File extractor complete', { files: uniqueUrls.length, extracted: results.length });
  return results;
}
