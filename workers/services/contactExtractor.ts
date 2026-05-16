import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';

export interface ExtractedContact {
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  emails: Array<{ address: string; type: 'pattern_inferred'; confidence: number; verified: boolean; source: string }>;
  sources: Array<{ url: string; type: 'company_website'; scrapedAt: Date; confidence: number }>;
}

/**
 * Team/people page path guesses. Ordered by frequency across corporate + pro-services
 * sites. Law firms in particular favor /partners, /attorneys, /our-lawyers.
 */
const TEAM_PATHS = [
  '/team', '/our-team', '/team-members',
  '/people', '/our-people',
  '/leadership', '/management', '/executives',
  '/partners', '/our-partners',
  '/attorneys', '/lawyers', '/our-lawyers',
  '/professionals', '/practitioners',
  '/staff',
  '/about', '/about-us',
];

async function tryPage(page: Page, url: string): Promise<ExtractedContact[]> {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    if (!resp || resp.status() >= 400) return [];

    const contacts = await page.evaluate(() => {
      const results: Array<{ name: string; title?: string }> = [];

      // 1. JSON-LD Person schemas
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent ?? '');
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item['@type'] === 'Person' && item.name) {
              results.push({ name: item.name, title: item.jobTitle });
            }
          }
        } catch { /* ignore malformed JSON-LD */ }
      }

      // 2. data-name / data-title attributes
      document.querySelectorAll('[data-name]').forEach(el => {
        const name = (el as HTMLElement).dataset['name'];
        const title = (el as HTMLElement).dataset['title'];
        if (name) results.push({ name, title });
      });

      // 3. Class-named selectors only — generic h2/h3/h4/h5 was producing
      //    junk like "Helpful Tips" / "Buying Guide" parsed as person names.
      //    Real team pages mark up team members with semantic class names
      //    (.team-member, .attorney-card, etc.) — those are reliable signals.
      //    Generic headings are not.
      //
      //    NAME_PATTERN matches: "Firstname Lastname", "Firstname M. Lastname",
      //    "Firstname-Smith Lastname". It still rejects all-caps headers,
      //    single words, and 5+ word phrases.
      const NAME_PATTERN = /^[A-Z][a-z'-]+(?: [A-Z]\.?)?(?: [A-Z][a-z'-]+){1,3}$/;
      // Belt-and-suspenders blocklist for cases where a class-named element
      // contains non-person text (rare but happens on poorly templated sites).
      const NON_NAME_WORDS = new Set([
        'about','our','the','home','contact','news','careers','services',
        'practice','areas','locations','who','what','how','why','when','where',
        'we','us','get','read','learn','meet','find','work','join','see','view',
        'explore','discover','more','all','new','free','best','top','latest',
        'click','here','now','today','you','your','do','are','is','was','has',
        'can','will','may','might','for','and','but','not','with',
        'helpful','tips','guide','case','studies','faqs','faq','blog','post',
        'page','site','web','online','digital','solutions','products','platform',
      ]);
      const PERSON_SELECTORS = [
        'a.person', 'a.attorney', 'a.lawyer',
        '.member-name', '.team-member-name', '.team-member',
        '.attorney-name', '.attorney-card',
        '.person-name', '.partner-name',
        '.staff-member', '.staff-name',
        '.leadership-name', '.executive-name',
        '[itemtype*="schema.org/Person"]',
      ].join(', ');
      const headings = Array.from(document.querySelectorAll(PERSON_SELECTORS));
      for (const h of headings) {
        const text = h.textContent?.trim().replace(/\s+/g, ' ') ?? '';
        if (!NAME_PATTERN.test(text)) continue;
        // Reject if any word in the text is a known non-name word.
        const words = text.toLowerCase().split(/\s+/);
        if (words.some(w => NON_NAME_WORDS.has(w))) continue;

        // Look for an adjacent title element — sibling, or a child of the same card.
        const candidates: (Element | null)[] = [
          h.nextElementSibling,
          h.parentElement?.querySelector('.title, .role, .position, .job-title, .attorney-title, .member-title') ?? null,
          h.parentElement?.nextElementSibling ?? null,
        ];
        let titleText: string | undefined;
        for (const c of candidates) {
          if (!c) continue;
          const t = c.textContent?.trim().replace(/\s+/g, ' ');
          if (t && t.length >= 2 && t.length <= 120 && t !== text) {
            titleText = t;
            break;
          }
        }
        results.push({ name: text, title: titleText });
      }

      return results;
    });

    return contacts.map(({ name, title }) => {
      const parts = name.trim().split(/\s+/);
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ') || undefined;
      return {
        fullName: name,
        firstName,
        lastName,
        title,
        emails: [],
        sources: [{ url, type: 'company_website' as const, scrapedAt: new Date(), confidence: 0.7 }],
      };
    });
  } catch {
    return [];
  }
}

/**
 * Note: pattern-inferred email generation (`inferEmails`) used to live here.
 * It was removed because firstname.lastname@domain is a fabrication, not a
 * data point — and the system was surfacing those guesses to users as real
 * emails. Real emails come from Hunter, SERP-snippet extraction, or the
 * agent's own search results. If a contact has no email, it has no email.
 */

export async function extractContacts(page: Page, domain: string): Promise<ExtractedContact[]> {
  const allContacts: ExtractedContact[] = [];
  const seen = new Set<string>();

  for (const path of TEAM_PATHS) {
    const url = `https://${domain}${path}`;
    const found = await tryPage(page, url);
    for (const c of found) {
      if (!seen.has(c.fullName.toLowerCase())) {
        seen.add(c.fullName.toLowerCase());
        // No email inference. Contacts emit with empty emails[]; downstream
        // sources (Hunter, SERP, agent search) attach addresses where possible.
        allContacts.push(c);
      }
    }
    if (allContacts.length >= 20) break; // cap per domain
  }

  logger.info('contactExtractor: extracted contacts', { domain, count: allContacts.length });
  return allContacts;
}
