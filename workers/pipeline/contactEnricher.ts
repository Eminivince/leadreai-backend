import type { Job } from 'bullmq';
import mongoose from 'mongoose';
import { chromium } from 'playwright';
import { logger } from '../utils/logger.js';
import { extractContacts, type ExtractedContact } from '../services/contactExtractor.js';
import { mapSeniority } from '../services/seniorityMapper.js';
import { hunterDomainSearch, isHunterConfigured } from '../services/hunter.js';
import { extractContactsFromSerp } from '../services/serpContactExtractor.js';

// Inline Contact model (strict:false — workers never import from backend)
const contactSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contact: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Contact'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Contact', contactSchema, 'contacts');

const leadSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Lead: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', leadSchema, 'leads');

export interface ContactEnrichmentPayload {
  workspaceId: string;
  leadId: string;
  companyDomain: string;
  companyName: string;
  websiteUrl?: string;
  existingEmails: string[];
  /** The user's original prospecting query, passed through so the SERP
   *  extractor can prioritise contacts matching the brief's persona
   *  (HR, sales, CTO, etc.) rather than defaulting to leadership. */
  personaContext?: string;
  /** Optional explicit role keywords parsed from the brief — used to make
   *  SERP queries more targeted than the default broad fallback. */
  roleKeywords?: string[];
}

export async function enrichContacts(job: Job<ContactEnrichmentPayload>): Promise<void> {
  const { workspaceId, leadId, companyDomain, companyName, personaContext, roleKeywords } = job.data;
  logger.info('contactEnricher: starting', { leadId, companyDomain });

  // ── Hunter.io first (when configured) ──────────────────────────────
  // Hunter returns named work-emails by domain even when the company has
  // no public team page — which is the failure mode driving most of our
  // "zero contacts found" cases. We run it before the browser-based scrape
  // so we get a baseline even when the scrape returns nothing.
  //
  // We accept BOTH personal and generic emails:
  //   - personal (firstName attached) → becomes a Contact record
  //   - generic (info@, contact@, etc.) → attached directly to lead.emails
  //     as type='generic'. These satisfy "I need an email" briefs even when
  //     no named individual is publicly listed — the user can still reach
  //     out to the company at info@. They're real (Hunter saw them in
  //     public sources), so they pass the quality gate.
  const hunterContacts: ExtractedContact[] = [];
  const hunterGenericEmails: Array<{
    address: string; type: 'generic'; confidence: number; verified: boolean; source: string;
  }> = [];
  // Skip Hunter for empty / placeholder domains — Hunter has data for many
  // generic-sounding domains that are NOT this company's actual web
  // presence (e.g. unknown.com is a real registered domain owned by an
  // unrelated entity). Calling Hunter on those returns wrong-company
  // emails and corrupts the lead.
  const PLACEHOLDER = /^(unknown|example|tbd|placeholder|none|na|company|business|domain|noemail|nowebsite)\.(com|org|net)$/i;
  const skipHunter = !companyDomain || !companyDomain.includes('.') || PLACEHOLDER.test(companyDomain);
  if (isHunterConfigured() && !skipHunter) {
    try {
      // No type filter — fetch both personal and generic in a single call.
      const hunter = await hunterDomainSearch(companyDomain);
      for (const hit of hunter.emails) {
        const isPersonal = hit.emailType === 'personal' && Boolean(hit.firstName);
        if (isPersonal) {
          const fullName = [hit.firstName, hit.lastName].filter(Boolean).join(' ').trim();
          if (!fullName) continue;
          hunterContacts.push({
            fullName,
            firstName: hit.firstName,
            lastName: hit.lastName,
            title: hit.position,
            emails: [{
              address: hit.address,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              type: 'business' as any,
              confidence: Math.max(0, Math.min(1, hit.confidence / 100)),
              verified: hit.verifierStatus === 'valid',
              source: 'hunter.io',
            }],
            sources: [{
              url: `https://hunter.io/${encodeURIComponent(companyDomain)}`,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              type: 'company_website' as any,
              scrapedAt: new Date(),
              confidence: Math.max(0, Math.min(1, hit.confidence / 100)),
            }],
          });
        } else {
          // Generic email (info@, contact@, hello@, etc.). Attach to the
          // lead directly as a company-level email — no person, but still a
          // real, scraped, reachable address.
          hunterGenericEmails.push({
            address: hit.address.toLowerCase().trim(),
            type: 'generic',
            confidence: Math.max(0, Math.min(1, hit.confidence / 100)),
            verified: hit.verifierStatus === 'valid',
            source: 'hunter.io',
          });
        }
      }
      if (hunterContacts.length > 0 || hunterGenericEmails.length > 0) {
        logger.info('contactEnricher: hunter contributed contacts/emails', {
          leadId, companyDomain,
          personal: hunterContacts.length,
          generic: hunterGenericEmails.length,
        });
      }
    } catch (err) {
      // Hunter errors are non-fatal — the scrape path still runs below.
      logger.warn('contactEnricher: hunter call threw', {
        leadId, companyDomain,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── SERP-based contact extraction ──────────────────────────────────
  // Most Nigerian SMEs and small B2B companies don't publish team pages.
  // But Google indexes press, news, LinkedIn snippets, and bios — and
  // those often name founders / CEOs / owners explicitly. We bundle the
  // top SERP snippets and ask a fast LLM to extract named individuals.
  // No page fetches; just snippet reading. This is now the PRIMARY
  // contact-finding path; team-page scrape is the last-resort fallback.
  const serpContacts: ExtractedContact[] = [];
  try {
    const fromSerp = await extractContactsFromSerp(companyName, {
      companyDomain,
      personaContext,
      roleKeywords,
    });
    for (const c of fromSerp) {
      const tokens = c.fullName.split(/\s+/);
      serpContacts.push({
        fullName: c.fullName,
        firstName: tokens[0],
        lastName: tokens.slice(1).join(' ') || undefined,
        title: c.title,
        // SERP extraction yields names + titles + sourceUrl, but rarely emails.
        // The contact gets an email only when Hunter or a downstream verifier
        // attaches one. We deliberately do NOT pattern-infer here — those
        // were the fabrications driving the trust failure.
        emails: [],
        sources: [{
          url: c.sourceUrl,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          type: 'company_website' as any,
          scrapedAt: new Date(),
          confidence: c.confidence,
        }],
      });
    }
    if (serpContacts.length > 0) {
      logger.info('contactEnricher: serp extractor contributed contacts', {
        leadId, companyName, count: serpContacts.length,
      });
    }
  } catch (err) {
    logger.warn('contactEnricher: serp extractor threw', {
      leadId, companyName,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);

  try {
    // Team-page scrape as the last-resort fallback. Real team pages exist
    // on a minority of target-market sites; the class-named selectors keep
    // false positives low even when the scrape does run.
    const scraped = await extractContacts(page, companyDomain);

    // Merge Hunter + SERP + scrape, deduping by lowercased full name.
    // Hunter wins on collision (has verification metadata), then SERP
    // (has a source URL), then scrape (lowest signal-to-noise).
    const seen = new Set<string>();
    const extracted: ExtractedContact[] = [];
    for (const c of [...hunterContacts, ...serpContacts, ...scraped]) {
      const key = c.fullName.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      extracted.push(c);
    }

    if (extracted.length === 0) {
      logger.info('contactEnricher: no named contacts found', {
        leadId, companyName, companyDomain,
        sources_tried: { hunter: isHunterConfigured(), serp: true, scrape: true },
        hunter_generic_emails: hunterGenericEmails.length,
      });

      // Even with no named contacts, we may have generic emails (info@,
      // contact@) from Hunter that satisfy the brief's email requirement.
      // Attach those to the lead before returning.
      if (hunterGenericEmails.length > 0) {
        await attachCompanyEmailsToLead(Lead, leadId, hunterGenericEmails);
        logger.info('contactEnricher: attached generic emails (no named contacts)', {
          leadId, count: hunterGenericEmails.length,
        });
      } else {
        logger.info('[thoughts] all contact sources returned zero', {
          companyName, companyDomain,
          suggestion: 'Hunter (personal+generic), SERP-snippet extraction, and team-page scrape all returned 0. Likely cases: (a) sole-proprietor SME with no public-facing leadership info or shared mailbox. (b) Apollo/PDL would help here — they have wider people coverage than Hunter. (c) LinkedIn Sales Navigator surfaces employees by company even when no email is public.',
        });
      }
      return;
    }

    // Upsert contacts — key: (workspaceId, leadId, normalised fullName)
    const ops = extracted.map(c => {
      const seniorityResult = c.title ? mapSeniority(c.title) : { seniority: 'unknown', department: 'other' };
      return {
        updateOne: {
          filter: {
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            leadId: new mongoose.Types.ObjectId(leadId),
            fullName: { $regex: new RegExp(`^${c.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          },
          update: {
            $setOnInsert: {
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              leadId: new mongoose.Types.ObjectId(leadId),
              fullName: c.fullName,
              firstName: c.firstName,
              lastName: c.lastName,
              title: c.title,
              seniority: seniorityResult.seniority,
              department: seniorityResult.department,
              emails: c.emails,
              phones: [],
              sources: c.sources,
              confidenceScore: 60,
              freshnessScore: 100,
              isActive: true,
              tags: [],
              crmRefs: [],
            },
          },
          upsert: true,
        },
      };
    });

    // Tolerate E11000 duplicates: same email can legitimately appear on multiple
    // leads (e.g. founder at CoA is also advisor at CoB). With `ordered:false`
    // MongoDB continues the batch past a dupe, but the mongoose driver still
    // throws afterward — so we catch the error and extract the partial result
    // to keep the successful writes. Other error codes we re-throw.
    let upsertedCount = 0;
    let matchedCount = 0;
    try {
      const result = await Contact.bulkWrite(ops, { ordered: false });
      upsertedCount = result.upsertedCount;
      matchedCount = result.matchedCount;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      const writeErrors: Array<{ code?: number }> = e?.writeErrors ?? e?.result?.result?.writeErrors ?? [];
      const allDupes = writeErrors.length > 0 && writeErrors.every((w) => w.code === 11000);
      if (allDupes) {
        upsertedCount = e?.result?.result?.nUpserted ?? e?.insertedCount ?? 0;
        matchedCount = e?.result?.result?.nMatched ?? 0;
        logger.info('contactEnricher: tolerated duplicate key errors', {
          leadId, dupes: writeErrors.length, upsertedCount,
        });
      } else {
        throw err;
      }
    }
    logger.info('contactEnricher: contacts upserted', {
      leadId,
      upserted: upsertedCount,
      matched: matchedCount,
    });

    // Update lead contactSummary + write contact emails back to lead.emails[]
    // so the lead record itself has reachable email addresses (not just contactSummary).
    const totalContacts = await Contact.countDocuments({
      leadId: new mongoose.Types.ObjectId(leadId),
      isActive: true,
    });

    // Fetch top contacts (by confidence) to pull their emails onto the lead record.
    // We project the email `type` field so we can preserve provenance —
    // historically this was hardcoded to 'work' on copy, which laundered
    // pattern_inferred (guesses) into business-looking emails and bypassed
    // the write-time quality gate. That bug surfaced as e.g. "helpful.tips@
    // greenfieldoil.com" being shown to users as a real contact email.
    const topContacts = await Contact.find(
      { leadId: new mongoose.Types.ObjectId(leadId), isActive: true },
      { fullName: 1, title: 1, seniority: 1, emails: 1, confidenceScore: 1 }
    ).sort({ confidenceScore: -1 }).limit(10).lean() as unknown as Array<{
      fullName: string; title?: string; seniority?: string;
      emails?: Array<{ address: string; type?: string; confidence: number; source: string; verified?: boolean }>;
      confidenceScore?: number;
    }>;

    const topContact = topContacts[0];

    // Map a Contact's email type onto the LEAD_EMAIL_TYPES enum.
    // Anything we don't recognize defaults to 'business' (the safe assumption
    // for an email that came from a structured data source). pattern_inferred
    // is preserved verbatim so the quality gate can still drop guesses.
    const VALID_LEAD_TYPES = new Set(['business', 'generic', 'personal', 'pattern_inferred']);
    const normaliseEmailType = (t: string | undefined): string =>
      t && VALID_LEAD_TYPES.has(t) ? t : 'business';

    // Build email entries for the lead record — one per contact email,
    // tagged with the contact's name/title.
    const contactEmails = topContacts.flatMap(c =>
      (c.emails ?? [])
        .filter(e => e.address && e.address.includes('@'))
        .map(e => ({
          address: e.address.toLowerCase().trim(),
          // Preserve the original provenance — DON'T launder pattern_inferred
          // into a real-looking type. The quality gate downstream relies on
          // this distinction to drop leads whose only emails are guesses.
          type: normaliseEmailType(e.type),
          confidence: e.confidence ?? 0.5,
          verified: e.verified === true,
          name: c.fullName,
          title: c.title ?? '',
          source: e.source ?? 'contact_enrichment',
        }))
    ).slice(0, 20);

    const leadUpdate: Record<string, unknown> = {
      'contactSummary.totalContacts': totalContacts,
      'contactSummary.topContact': topContact
        ? { fullName: topContact.fullName, title: topContact.title ?? '', seniority: topContact.seniority ?? 'unknown' }
        : undefined,
    };

    // Merge: contact-derived emails (named individuals) + Hunter generic
    // emails (info@, contact@) + existing lead.emails (whatever the agent's
    // write_lead tool put there). Dedupe by lowercased address.
    const allNewEmails = [
      ...contactEmails,
      ...hunterGenericEmails.map((e) => ({
        address: e.address,
        type: e.type,
        confidence: e.confidence,
        verified: e.verified,
        source: e.source,
      })),
    ];

    if (allNewEmails.length > 0) {
      const existingLead = await Lead.findById(
        new mongoose.Types.ObjectId(leadId),
        { emails: 1 }
      ).lean() as { emails?: Array<{ address: string; type: string; confidence: number; verified?: boolean; source: string }> } | null;

      const seen = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const merged: any[] = [];
      for (const e of (existingLead?.emails ?? [])) {
        const key = e.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(e);
      }
      for (const e of allNewEmails) {
        const key = e.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(e);
      }
      leadUpdate['emails'] = merged;
    } else if (totalContacts > 0) {
      logger.info('[thoughts] contacts found but none have email addresses', {
        companyDomain,
        totalContacts,
        suggestion: 'Pattern-inference email generation (firstname.lastname@domain) would create probable addresses for named contacts with no public email. Hunter.io or Apollo could verify whether the inferred address is deliverable before we commit it.',
      });
    }

    await Lead.updateOne(
      { _id: new mongoose.Types.ObjectId(leadId) },
      { $set: leadUpdate }
    );
  } finally {
    await browser.close();
  }
}

/**
 * Merges company-level emails (e.g. Hunter generics like info@, contact@)
 * onto a lead's emails array, deduping by lowercased address. Used when
 * we have generic emails but no named contacts — the lead still benefits
 * from a reachable address even without a person attached.
 */
async function attachCompanyEmailsToLead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LeadModel: mongoose.Model<any>,
  leadId: string,
  newEmails: Array<{ address: string; type: string; confidence: number; verified: boolean; source: string }>,
): Promise<void> {
  if (newEmails.length === 0) return;
  const existingLead = await LeadModel.findById(
    new mongoose.Types.ObjectId(leadId),
    { emails: 1 }
  ).lean() as { emails?: Array<{ address: string; type: string; confidence: number; verified?: boolean; source: string }> } | null;

  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged: any[] = [];
  for (const e of existingLead?.emails ?? []) {
    const key = e.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  for (const e of newEmails) {
    const key = e.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  await LeadModel.updateOne(
    { _id: new mongoose.Types.ObjectId(leadId) },
    { $set: { emails: merged } },
  );
}
