import axios from 'axios';
import OpenAI, { toFile } from 'openai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { recordTranscriptionCost } from './costTracker.js';

/* ─────────────────────────────────────────────────────────────────
 * Whisper-style transcription client.
 *
 * Downloads an audio/video URL (capped at TRANSCRIPTION_MAX_MB — the
 * default 25MB matches OpenAI Whisper's per-request limit), posts it
 * to `/audio/transcriptions`, returns the raw text.
 *
 * Key/base-URL cascade: use TRANSCRIPTION_* if set, otherwise fall
 * back to EMBEDDING_* so a single OpenAI API key enables both RAG
 * and transcription.
 *
 * NOT handled here (by design, for now):
 *   · YouTube / Vimeo / Spotify — need yt-dlp + ffmpeg shelled out
 *   · Files > 25MB — need ffmpeg to split into segments
 * Both are follow-ups; the ~25MB direct-audio case covers most
 * podcast episodes and all direct MP3/M4A/MP4 links.
 * ───────────────────────────────────────────────────────────────── */

function resolvedApiKey(): string | undefined {
  return env.TRANSCRIPTION_API_KEY || env.EMBEDDING_API_KEY;
}

function resolvedBaseUrl(): string {
  return env.TRANSCRIPTION_BASE_URL || env.EMBEDDING_BASE_URL;
}

export function isTranscriptionConfigured(): boolean {
  return !!resolvedApiKey();
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    const key = resolvedApiKey();
    if (!key) throw new Error('Transcription API key is not configured');
    _client = new OpenAI({ apiKey: key, baseURL: resolvedBaseUrl() });
  }
  return _client;
}

export interface TranscriptionResult {
  text: string;
  durationSeconds?: number;
  language?: string;
  bytes: number;
  mimeType?: string;
}

function isAudioishContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return (
    lower.startsWith('audio/') ||
    lower.startsWith('video/') ||
    lower === 'application/ogg' ||
    lower === 'application/octet-stream'
  );
}

function filenameFromUrl(url: string, mimeType: string | undefined): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop();
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  } catch {
    /* fall through */
  }
  // OpenAI requires the filename to carry a recognizable extension so
  // Whisper picks the right decoder. Default to .mp3 when the MIME
  // hints audio and we can't parse a path.
  if (mimeType?.startsWith('audio/mp4')) return 'audio.m4a';
  if (mimeType?.includes('wav')) return 'audio.wav';
  if (mimeType?.includes('ogg')) return 'audio.ogg';
  if (mimeType?.startsWith('video/mp4')) return 'audio.mp4';
  return 'audio.mp3';
}

export async function transcribeUrl(url: string): Promise<TranscriptionResult | null> {
  if (!isTranscriptionConfigured()) {
    logger.warn('[transcription] TRANSCRIPTION_API_KEY / EMBEDDING_API_KEY not configured');
    return null;
  }

  const maxBytes = env.TRANSCRIPTION_MAX_MB * 1024 * 1024;

  // HEAD first to guard the size cap. Some CDNs don't support HEAD —
  // we fall back to a byte-limited GET below.
  let contentType: string | undefined;
  let size = 0;
  try {
    const head = await axios.head(url, {
      timeout: 15_000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    contentType = (head.headers['content-type'] as string | undefined) ?? undefined;
    const len = Number(head.headers['content-length']);
    if (Number.isFinite(len)) size = len;
  } catch {
    /* ignore — rely on GET below */
  }

  if (size > maxBytes) {
    logger.warn('[transcription] file too large, skipping', { url, bytes: size, cap: maxBytes });
    return null;
  }

  let buffer: Buffer;
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: maxBytes,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    buffer = Buffer.from(res.data);
    if (!contentType) {
      contentType = (res.headers['content-type'] as string | undefined) ?? undefined;
    }
  } catch (err) {
    logger.warn('[transcription] download failed', {
      url,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (buffer.length > maxBytes) {
    logger.warn('[transcription] payload exceeds cap', { url, bytes: buffer.length });
    return null;
  }

  if (!isAudioishContentType(contentType) && !/\.(mp3|m4a|mp4|wav|ogg|webm|aac|flac)(\?|$)/i.test(url)) {
    logger.warn('[transcription] URL does not look like audio/video', { url, contentType });
    return null;
  }

  const name = filenameFromUrl(url, contentType);

  try {
    const file = await toFile(buffer, name, contentType ? { type: contentType } : undefined);
    // verbose_json includes duration + language; we use them for metadata.
    const res = await client().audio.transcriptions.create({
      file,
      model: env.TRANSCRIPTION_MODEL,
      response_format: 'verbose_json',
    });
    // The SDK's verbose_json type is a union; cast to a structural shape
    // we actually read.
    const r = res as unknown as { text?: string; duration?: number; language?: string };
    if (!r.text) {
      logger.warn('[transcription] whisper returned empty text', { url });
      return null;
    }
    // Cost: per-minute billing based on reported audio duration.
    if (r.duration && r.duration > 0) {
      void recordTranscriptionCost('whisper', r.duration);
    }
    return {
      text: r.text,
      durationSeconds: r.duration,
      language: r.language,
      bytes: buffer.length,
      mimeType: contentType,
    };
  } catch (err) {
    logger.warn('[transcription] whisper call failed', {
      url,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
