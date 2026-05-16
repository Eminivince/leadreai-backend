import { load as cheerioLoad } from 'cheerio';
import { logger } from '../../utils/logger.js';
import type { ToolDef } from './index.js';

export interface FetchedPage {
  url: string;
  status: number;
  bodyText: string;
  jsonLd: unknown[];
  emails: string[];
  phones: string[];
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_TEXT = 6_000;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export async function fetchUrl(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LeadreaiBot/1.0; +https://leadreai.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok) {
      return { url, status: res.status, bodyText: '', jsonLd: [], emails: [], phones: [] };
    }

    const html = await res.text();
    const $ = cheerioLoad(html);

    const jsonLd: unknown[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) jsonLd.push(...parsed);
        else jsonLd.push(parsed);
      } catch { /* ignore */ }
    });

    $('script, style, nav, footer, svg').remove();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

    const emailSet = new Set<string>(bodyText.match(EMAIL_REGEX) ?? []);
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const email = href.replace('mailto:', '').split('?')[0];
      if (email) emailSet.add(email);
    });

    const phones: string[] = [];
    $('a[href^="tel:"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const p = href.replace('tel:', '').trim();
      if (p && p.replace(/\D/g, '').length >= 7) phones.push(p);
    });

    return {
      url,
      status: res.status,
      bodyText,
      jsonLd,
      emails: [...emailSet].filter(e => !e.includes('example.com')),
      phones,
    };
  } catch (err) {
    logger.warn('[fetchUrl] failed', { url, err: err instanceof Error ? err.message : String(err) });
    return { url, status: 0, bodyText: '', jsonLd: [], emails: [], phones: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export const fetchUrlTool: ToolDef = {
  name: 'fetch_url',
  description: 'Fetch a specific URL (no JS execution). Returns short preview of text, plus emails/phones/JSON-LD extracted.',
  parametersSchema: '{"url": string}',
  handler: async (args) => {
    const url = String(args?.url ?? '').trim();
    if (!url.startsWith('http')) return { ok: false, output: 'absolute URL required' };
    const r = await fetchUrl(url);
    return {
      ok: r.status > 0 && r.status < 400,
      output: JSON.stringify({
        status: r.status,
        emails: r.emails,
        phones: r.phones,
        jsonLdCount: r.jsonLd.length,
        bodyTextPreview: r.bodyText.slice(0, 1800),
      }),
    };
  },
};
