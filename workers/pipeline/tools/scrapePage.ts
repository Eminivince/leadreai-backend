import { chromium } from 'playwright';
import { runPageScraper } from '../pageScraper.js';
import type { ToolDef } from './index.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { recordScrapeCost } from '../../services/costTracker.js';

export const scrapePageTool: ToolDef = {
  name: 'scrape_page',
  description: 'Deep scrape a URL with a headless browser + LLM contact extraction. Heavy (~10-30s). Use sparingly on high-signal pages only.',
  parametersSchema: '{"url": string}',
  handler: async (args, ctx) => {
    const url = String(args?.url ?? '').trim();
    if (!url.startsWith('http')) return { ok: false, output: 'absolute URL required' };
    if (ctx.pagesScrapedThisJob.has(url)) {
      return { ok: true, output: JSON.stringify({ cached: true, reason: 'already scraped in this job' }) };
    }
    ctx.pagesScrapedThisJob.add(url);

    try {
      const results = await runPageScraper(
        [{ url, title: '', snippet: '', isFilePath: false }],
        ctx.publisher,
        ctx.jobId,
      );
      // Record cost on every scrape attempt — Playwright container CPU is
      // consumed even when the page returns 0 useful data.
      void recordScrapeCost('playwright');
      const page = results[0];
      if (!page) return { ok: false, output: 'scrape returned nothing' };
      return {
        ok: true,
        output: JSON.stringify({
          url: page.url,
          companyName: page.companyName,
          linkedinUrl: page.linkedinUrl,
          extractedContacts: page.extractedContacts,
          rawEmailCount: page.emails.length,
          rawPhoneCount: page.phones.length,
          textPreview: page.pageText.slice(0, 800),
        }),
        meta: { contactsFound: page.extractedContacts.length },
      };
    } catch (err) {
      logger.warn('[scrapePageTool] failed', { url, err: err instanceof Error ? err.message : String(err) });
      return { ok: false, output: `scrape failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

// Keep a singleton browser launched lazily — repeatedly launching/closing is expensive
// (not implemented in v1; runPageScraper already handles its own browser lifecycle)
void chromium; // suppress unused import warning — runPageScraper handles Playwright
void env;
