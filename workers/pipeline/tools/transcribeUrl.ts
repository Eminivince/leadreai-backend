import type { ToolDef } from './index.js';
import { parseFileAtUrl } from '../fileExtractor.js';
import { isTranscriptionConfigured } from '../../services/transcription.js';
import { recordTranscriptionCost } from '../../services/costTracker.js';

/* ─────────────────────────────────────────────────────────────────
 * transcribe_url — Whisper-style transcription for audio/video URLs.
 *
 * Works with direct media URLs: podcast MP3s from RSS feeds, embedded
 * MP4 interviews, WAV recordings, etc. Uses the same cache + chunking
 * pipeline as fetch_file — the transcript is a ParsedFile with
 * fileType='audio', so get_file_chunk can page through it identically.
 *
 * Capped at TRANSCRIPTION_MAX_MB (default 25MB, matching Whisper's
 * per-request limit). YouTube / Spotify / Vimeo URLs are NOT supported
 * yet — those need yt-dlp + ffmpeg shelled out.
 * ───────────────────────────────────────────────────────────────── */

export const transcribeUrlTool: ToolDef = {
  name: 'transcribe_url',
  description:
    'Transcribe an audio/video URL with Whisper. Works with direct media URLs (podcast MP3s, M4A, MP4 interviews, WAV, OGG). Returns cacheKey + transcript preview + extracted emails/phones — same shape as fetch_file, use get_file_chunk for more chunks. Capped at 25MB. YouTube / Spotify / Vimeo URLs not yet supported.',
  parametersSchema: '{"url": string}',
  handler: async (args) => {
    const url = String(args?.url ?? '').trim();
    if (!url.startsWith('http')) return { ok: false, output: 'absolute URL required' };

    if (!isTranscriptionConfigured()) {
      return {
        ok: false,
        output: JSON.stringify({
          error: 'not_configured',
          hint: 'Transcription is disabled: set TRANSCRIPTION_API_KEY (or reuse EMBEDDING_API_KEY) on the worker.',
        }),
      };
    }

    const parsed = await parseFileAtUrl(url);
    if (!parsed || parsed.fileType !== 'audio') {
      return {
        ok: false,
        output: JSON.stringify({
          error: 'could_not_transcribe',
          hint:
            'The URL either isn\u2019t a direct audio/video file, exceeded the 25MB cap, or Whisper rejected it. Try an RSS-style direct MP3 link, or note that YouTube/Spotify need a platform downloader that\u2019s not wired yet.',
        }),
      };
    }

    const meta = parsed.meta ?? {};
    const durationSeconds = typeof meta['durationSeconds'] === 'number' ? meta['durationSeconds'] : 0;
    void recordTranscriptionCost('whisper', durationSeconds);

    const preview = parsed.chunks[0]?.text?.slice(0, 2200) ?? '';

    return {
      ok: true,
      output: JSON.stringify({
        cacheKey: parsed.cacheKey,
        fileType: parsed.fileType,
        bytes: parsed.bytes,
        totalChars: parsed.totalChars,
        chunkCount: parsed.chunks.length,
        durationSeconds: meta['durationSeconds'],
        language: meta['language'],
        preview,
        emails: parsed.emails.slice(0, 40),
        phones: parsed.phones.slice(0, 40),
        hint:
          parsed.chunks.length > 1
            ? `Transcript has ${parsed.chunks.length} chunks. Call get_file_chunk(cacheKey, idx) for chunks 1..${parsed.chunks.length - 1}.`
            : 'Full transcript is in preview.',
      }),
    };
  },
};
