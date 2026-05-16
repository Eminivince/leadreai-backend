import { chromium, type Browser, type BrowserContext } from 'playwright';
import { Redis } from 'ioredis';
import { load as cheerioLoad } from 'cheerio';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { SerpResult } from './serpScraper.js';
import { extractContacts, type ContactCandidate } from './aiContactExtractor.js';

const PROXIES: Array<{ server: string; username?: string; password?: string }> = (
  env.PROXY_LIST ? env.PROXY_LIST.split(',').map((p) => p.trim()).filter(Boolean) : []
).map((raw) => {
  try {
    const url = new URL(raw);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch {
    return { server: raw };
  }
});

let proxyIndex = 0;
function nextProxy(): { server: string; username?: string; password?: string } | undefined {
  if (PROXIES.length === 0) return undefined;
  // eslint-disable-next-line no-plusplus
  return PROXIES[proxyIndex++ % PROXIES.length];
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?[\d]{1,3}[\s\-.])?(?:\([\d]{1,4}\)[\s\-.])?[\d]{3,5}[\s\-.][\d]{3,5}(?:[\s\-.][\d]{2,5})?/g;
const FILE_EXT_REGEX = /\.(pdf|docx?|xlsx?)(\?[^"']*)?$/i;
const SKIP_DOMAINS = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com', 'google.com'];

export interface PageScrapedData {
  url: string;
  emails: string[];        // raw email strings found on page
  phones: string[];        // raw phone strings found on page
  fileUrls: string[];      // absolute URLs to downloadable files (.pdf/.docx/.doc/.xlsx/.xls)
  companyName?: string;    // from OpenGraph og:site_name or JSON-LD
  linkedinUrl?: string;    // linkedin.com/company/... URL found on page
  pageText: string;        // first 2000 chars of visible text (for fallback extraction)
  extractedContacts: ContactCandidate[];
}

const MAX_PAGES = 25;
const PAGE_DELAY_MS = 300;
const SCRAPER_TIMEOUT_MS = 90_000;

export async function runPageScraper(
  serpResults: SerpResult[],
  publisher: Redis,
  jobId: string
): Promise<PageScrapedData[]> {
  // Skip file URLs and social/search domains; cap at MAX_PAGES
  const pageUrls = serpResults
    .filter(r => !r.isFilePath && !SKIP_DOMAINS.some(d => r.url.includes(d)))
    .slice(0, MAX_PAGES);
  const fileUrls = serpResults.filter(r => r.isFilePath).map(r => r.url);

  logger.info('pageScraper: launching browser', { jobId, pagesToScrape: pageUrls.length });

  const browser = await chromium.launch({ headless: env.PLAYWRIGHT_HEADLESS });
  const results: PageScrapedData[] = [];
  const semaphore = new Semaphore(env.PLAYWRIGHT_CONCURRENCY);

  try {
    const scrapeAll = Promise.all(
      pageUrls.map(serpResult =>
        semaphore
          .run(() => scrapePage(browser, serpResult.url, fileUrls))
          .then(data => {
            if (data) {
              results.push(data);
              logger.info('pageScraper: page scraped', {
                jobId, url: serpResult.url, emails: data.emails.length, phones: data.phones.length,
              });
            }
          })
          .catch(err =>
            logger.warn('pageScraper: page failed', { jobId, url: serpResult.url, err: err instanceof Error ? err.message : String(err) })
          )
      )
    );

    await Promise.race([
      scrapeAll,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`pageScraper timeout after ${SCRAPER_TIMEOUT_MS}ms`)), SCRAPER_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    logger.warn('pageScraper: finishing early', { jobId, reason: err instanceof Error ? err.message : String(err), collected: results.length });
  } finally {
    await browser.close();
  }

  // Add file URLs gathered from snippet-only results
  if (fileUrls.length > 0) {
    const fileOnlyData: PageScrapedData = {
      url: 'collected-files',
      emails: [],
      phones: [],
      fileUrls,
      pageText: '',
      extractedContacts: [],
    };
    results.push(fileOnlyData);
  }

  logger.info('Page scraper complete', { pages: pageUrls.length, results: results.length });
  return results;
}

// Per-worker cache of domains that recently timed out / failed hard.
// Prevents us from wasting 30s × N URLs on a dead or Playwright-hostile host.
const FAILED_DOMAIN_CACHE = new Map<string, number>();
const FAILED_DOMAIN_TTL_MS = 5 * 60 * 1000;

function getPlainDomain(u: string): string {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function isDomainFailing(domain: string): boolean {
  const expiry = FAILED_DOMAIN_CACHE.get(domain);
  if (!expiry) return false;
  if (Date.now() > expiry) { FAILED_DOMAIN_CACHE.delete(domain); return false; }
  return true;
}

function markDomainFailing(domain: string): void {
  FAILED_DOMAIN_CACHE.set(domain, Date.now() + FAILED_DOMAIN_TTL_MS);
}

async function scrapePage(
  browser: Browser,
  url: string,
  collectedFileUrls: string[]
): Promise<PageScrapedData | null> {
  const plainDomain = getPlainDomain(url);
  if (plainDomain && isDomainFailing(plainDomain)) {
    logger.info('pageScraper: skipping known-failing domain', { url, domain: plainDomain });
    return null;
  }

  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({
      userAgent: randomUserAgent(),
      ignoreHTTPSErrors: true,
      proxy: nextProxy(),
    });
    const page = await context.newPage();

    await page.goto(url, {
      timeout: env.PLAYWRIGHT_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });

    // Dismiss common cookie banners
    for (const selector of [
      'button:has-text("Accept")',
      'button:has-text("Accept All")',
      '[id*="cookie"] button',
      '[class*="cookie"] button',
    ]) {
      await page.click(selector, { timeout: 2000 }).catch(() => {});
    }

    const html = await page.content();
    const $ = cheerioLoad(html);

    // Extract JSON-LD structured data BEFORE stripping script tags
    const jsonLdBlobs: unknown[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) jsonLdBlobs.push(...parsed);
        else jsonLdBlobs.push(parsed);
      } catch { /* ignore malformed JSON-LD */ }
    });

    // Remove script/style noise for text extraction
    $('script, style, nav, footer').remove();

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

    // Extract emails from page text
    const emailSet = new Set<string>(bodyText.match(EMAIL_REGEX) ?? []);
    // Also check mailto: links
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const email = href.replace('mailto:', '').split('?')[0];
      if (email) emailSet.add(email);
    });
    const emailMatches = [...emailSet];

    // Extract phones from tel: links (highest confidence) + body text regex
    const phoneSet = new Set<string>();
    $('a[href^="tel:"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const phone = href.replace('tel:', '').trim();
      if (phone && phone.replace(/\D/g, '').length >= 7) phoneSet.add(phone);
    });
    // Body text regex extraction — filter out obvious false positives (zip codes, years, prices)
    const bodyPhoneMatches = bodyText.match(PHONE_REGEX) ?? [];
    for (const raw of bodyPhoneMatches) {
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) continue;
      // Skip 4-digit years (1900-2099) and plain integers under 8 digits
      if (/^(19|20)\d{2}$/.test(digits)) continue;
      phoneSet.add(raw.trim());
    }
    const phoneMatches = [...phoneSet];

    // Extract file links
    const foundFileUrls: string[] = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (FILE_EXT_REGEX.test(href)) {
        const absolute = href.startsWith('http') ? href : new URL(href, url).href;
        foundFileUrls.push(absolute);
        collectedFileUrls.push(absolute);
      }
    });

    // Company name from OpenGraph
    const companyName =
      $('meta[property="og:site_name"]').attr('content') ??
      $('meta[name="application-name"]').attr('content') ??
      undefined;

    // LinkedIn URL
    let linkedinUrl: string | undefined;
    $('a[href*="linkedin.com/company"]').each((_, el) => {
      if (!linkedinUrl) linkedinUrl = $(el).attr('href');
    });

    // Small rate-limit delay
    await new Promise(resolve => setTimeout(resolve, PAGE_DELAY_MS));

    const cleanEmails = emailMatches.filter(e => e.includes('@') && !e.includes('example.com'));

    // LLM contact extraction — understands context, filters noise, pulls from JSON-LD + staff cards
    const extractedContacts = await extractContacts({
      url,
      domain: new URL(url).hostname.replace(/^www\./, ''),
      bodyText,
      jsonLd: jsonLdBlobs,
      rawEmails: cleanEmails,
      rawPhones: phoneMatches,
    }).catch((err) => {
      logger.warn('pageScraper: extractContacts threw', { url, err: err instanceof Error ? err.message : String(err) });
      return [] as ContactCandidate[];
    });

    return {
      url,
      emails: cleanEmails,
      phones: phoneMatches,
      fileUrls: foundFileUrls,
      companyName,
      linkedinUrl,
      pageText: bodyText.slice(0, 2000),
      extractedContacts,
    };
  } catch (err) {
    // If the whole domain is timing out, blocklist it so subsequent URL variants
    // don't waste another 30s each.
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('Timeout') || msg.includes('timeout');
    const isSslErr = msg.includes('SSL') || msg.includes('ERR_SSL') || msg.includes('ERR_CERT');
    if (plainDomain && (isTimeout || isSslErr)) {
      markDomainFailing(plainDomain);
      logger.info('pageScraper: marked domain as failing', { domain: plainDomain, reason: isTimeout ? 'timeout' : 'ssl' });
    }
    logger.warn('scrapePage error', { url, err });
    return null;
  } finally {
    await context?.close();
  }
}

// Simple semaphore for concurrency control
class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];
  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  private release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] ?? USER_AGENTS[0]!;
}

