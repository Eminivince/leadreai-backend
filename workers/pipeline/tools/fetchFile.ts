import type { ToolDef } from './index.js';
import { parseFileAtUrl, type FileTable } from '../fileExtractor.js';
import { getCachedFileByKey } from '../../services/fileCache.js';
import { recordFileFetchCost } from '../../services/costTracker.js';

/* ─────────────────────────────────────────────────────────────────
 * fetch_file — download + parse a file at a URL.
 *
 * Supports PDF, DOCX, XLSX, CSV, TXT, HTML, MD. Cached in Redis for
 * 24h so two agents reading the same dork result don't re-download.
 *
 * Returns a compact summary for the LLM:
 *   · cacheKey           — pass to get_file_chunk for more chunks
 *   · fileType, bytes, pageCount?, chunkCount, totalChars
 *   · preview            — first chunk (~2KB of text)
 *   · emails, phones     — regex-extracted from full text
 *   · tables[0..2]       — header row + first few rows from each sheet/CSV
 *   · usedOcr            — true for scanned PDFs we ran tesseract on
 *
 * Use get_file_chunk with the returned cacheKey + chunk idx for anything
 * past chunk 0. Do NOT refetch the same URL — you'll lose context and
 * waste budget.
 * ───────────────────────────────────────────────────────────────── */

function tablePreview(t: FileTable): Record<string, unknown> {
  return {
    sheet: t.sheet,
    headers: t.headers,
    rowCount: t.rows.length,
    truncatedTo: t.truncatedTo,
    sampleRows: t.rows.slice(0, 5),
  };
}

export const fetchFileTool: ToolDef = {
  name: 'fetch_file',
  description:
    'Download and parse a file URL (PDF/DOCX/XLSX/CSV/TXT/HTML/MD). Returns cacheKey + first chunk preview + extracted emails/phones/tables. Great for filetype: dorks — attendee lists, investor reports, annual filings, data dumps. Call get_file_chunk for further chunks by cacheKey.',
  parametersSchema: '{"url": string}',
  handler: async (args) => {
    const url = String(args?.url ?? '').trim();
    if (!url.startsWith('http')) return { ok: false, output: 'absolute URL required' };

    const parsed = await parseFileAtUrl(url);
    if (!parsed) {
      return {
        ok: false,
        output: JSON.stringify({
          error: 'could_not_parse',
          hint:
            'The URL either 404/403\u2019d, exceeded the size cap, or isn\u2019t a parseable file type. Try a different source.',
        }),
      };
    }

    void recordFileFetchCost('http', parsed.bytes);

    const preview = parsed.chunks[0]?.text?.slice(0, 2200) ?? '';
    const emails = parsed.emails.slice(0, 40);
    const phones = parsed.phones.slice(0, 40);
    const tables = (parsed.tables ?? []).slice(0, 3).map(tablePreview);

    return {
      ok: true,
      output: JSON.stringify({
        cacheKey: parsed.cacheKey,
        fileType: parsed.fileType,
        bytes: parsed.bytes,
        pageCount: parsed.pageCount,
        chunkCount: parsed.chunks.length,
        totalChars: parsed.totalChars,
        usedOcr: parsed.usedOcr ?? false,
        preview,
        emails,
        phones,
        tables,
        hint:
          parsed.chunks.length > 1
            ? `File has ${parsed.chunks.length} chunks. Call get_file_chunk(cacheKey, idx) for chunks 1..${parsed.chunks.length - 1}.`
            : 'Full content is in preview.',
      }),
    };
  },
};

export const getFileChunkTool: ToolDef = {
  name: 'get_file_chunk',
  description:
    'Retrieve a specific chunk of a previously-parsed file by its cacheKey (from fetch_file). Use to page through long PDFs/docs without re-downloading.',
  parametersSchema: '{"cacheKey": string, "idx": number}',
  handler: async (args) => {
    const cacheKey = String(args?.cacheKey ?? '').trim();
    const idx = Number.isFinite(Number(args?.idx)) ? Math.max(0, Math.floor(Number(args.idx))) : -1;
    if (!cacheKey || idx < 0) {
      return { ok: false, output: 'cacheKey and non-negative idx required' };
    }

    const parsed = await getCachedFileByKey<{
      chunks: Array<{ idx: number; text: string; pageHint?: number }>;
      fileType: string;
    }>(cacheKey);

    if (!parsed) {
      return {
        ok: false,
        output: JSON.stringify({
          error: 'cache_miss',
          hint: 'That cacheKey expired (24h TTL) or was never cached. Re-run fetch_file on the source URL.',
        }),
      };
    }

    const chunk = parsed.chunks[idx];
    if (!chunk) {
      return {
        ok: false,
        output: JSON.stringify({
          error: 'chunk_out_of_range',
          have: parsed.chunks.length,
          requested: idx,
        }),
      };
    }

    return {
      ok: true,
      output: JSON.stringify({
        fileType: parsed.fileType,
        idx: chunk.idx,
        pageHint: chunk.pageHint,
        text: chunk.text,
        hasNext: idx + 1 < parsed.chunks.length,
      }),
    };
  },
};
