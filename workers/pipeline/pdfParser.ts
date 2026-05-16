import { PDFParse } from 'pdf-parse';
import { logger } from '../utils/logger.js';

/**
 * Thin wrapper over pdf-parse v2's class-based API.
 *
 * v2 changed the entry point from a bare function (v1: `pdfParse(buf)`)
 * to a `PDFParse` class with `.getText()` / `.getInfo()` / `.destroy()`.
 * Keeping the wrapper lets any callsite stay agnostic of the SDK shape
 * and gives us one place to thread options (e.g. page-level parse
 * params) if we need them later.
 */
export async function extractPdfText(
  buffer: Buffer,
): Promise<{ text: string; pageCount?: number }> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text, pageCount: result.total };
  } catch (err) {
    logger.warn('[pdfParser] extraction failed', {
      bytes: buffer.length,
      err: err instanceof Error ? err.message : String(err),
    });
    return { text: '' };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
