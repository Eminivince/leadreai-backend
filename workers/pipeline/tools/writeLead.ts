import type { ToolDef } from './index.js';
import type { LeadRecord } from '../deduplicator.js';
import { logger } from '../../utils/logger.js';
import { normalizePhones, countryNameToCode } from '../phoneNormalizer.js';
import { jobActivity } from '../intentParser.js';

/**
 * Rejects strings that look like page chrome / navigation text rather than a
 * human name. Backs up the agent-prompt rule with a code-level guard.
 *
 * A plausible human name:
 *   - is not empty / too short / too long
 *   - is not a single line of newlines or whitespace
 *   - does not match common UI-navigation labels
 *   - does not contain section-header verbs (History, Vision, About...)
 */
const UI_CHROME_PATTERNS = /^(related\s+pages?|our\s+(team|people|history|values|story)|about(\s+us)?|contact(\s+us)?|home|leadership|meet\s+(our|the)\s+team|vision\s+and\s+values|management\s+team|board\s+of\s+directors|menu|navigation|read\s+more|learn\s+more|click\s+here|the\s+pivot|the\s+team|the\s+story|the\s+mission|the\s+vision|the\s+history|the\s+company|the\s+firm)$/i;
const SECTION_HEADER_WORDS = /\b(History|Vision|Mission|Values|Story|Overview|Approach|Services|Expertise|Practice Areas?|Locations?|News|Careers|Portfolio|Pivot)\b/;
// Determiners/pronouns as first word — never a real human first name.
const DETERMINER_LEADING = /^(the|our|a|an|this|that|these|those|your|my|his|her|its)\s+/i;

function looksLikePersonName(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v.length < 3 || v.length > 100) return false;
  if (v.includes('\n')) return false;
  if (UI_CHROME_PATTERNS.test(v)) return false;
  if (SECTION_HEADER_WORDS.test(v)) return false;
  if (DETERMINER_LEADING.test(v)) return false;
  // Require at least one space (first + last name).
  if (!/\s/.test(v)) return false;
  // Too many capitalized words (>4) is usually a title string, not a name.
  const capWords = v.match(/\b[A-Z][a-z]+\b/g) ?? [];
  if (capWords.length > 4) return false;
  // Each word should start with a capital and contain only letters/apostrophes/hyphens
  // (allow e.g. "O'Brien", "Jean-Paul", middle initials). Rejects numbers and
  // mixed-case junk.
  const tokens = v.split(/\s+/);
  for (const t of tokens) {
    if (!/^[A-Z][a-zA-Z'.-]{0,}$/.test(t)) return false;
  }
  return true;
}

/**
 * Parses an unknown value into a finite number in [min, max]; falls back to `fallback`.
 * Guards against NaN sneaking into BSON (where NaN is persisted as null, which breaks
 * downstream ranking/filtering that expects a number).
 */
function clampToFiniteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Hosts where the "domain" is a shared platform, not an identity. Many
 * distinct leads legitimately share instagram.com / tiktok.com / etc.,
 * so we disambiguate them by appending a slug of the company/person
 * name to the domain. Without this the dedup layer (both the in-memory
 * leadsSoFar scan below and the downstream bulkWrite upsert filter)
 * collapses every influencer on the same platform into one record.
 */
const SOCIAL_PLATFORM_HOSTS = new Set([
  'instagram.com',
  'tiktok.com',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'facebook.com',
  'youtube.com',
  'threads.net',
  'snapchat.com',
  'pinterest.com',
]);

export function isSocialPlatformHost(host: string): boolean {
  return SOCIAL_PLATFORM_HOSTS.has(host);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/@/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * If the domain is a social platform, return `<host>/<slug(name)>` so
 * distinct profiles don't collide on the dedup key. Otherwise return
 * the domain unchanged.
 */
function identityDomain(rawDomain: string, companyName: string): string {
  if (!isSocialPlatformHost(rawDomain)) return rawDomain;
  const slug = slugify(companyName);
  return slug ? `${rawDomain}/${slug}` : rawDomain;
}

export const writeLeadTool: ToolDef = {
  name: 'write_lead',
  description: 'Commit a lead to the job results. Call this as soon as you have a companyName + companyDomain — an email is a bonus, not a requirement. Call it a second time to UPGRADE the same domain record when you find a named contact or verified email. Pass `facts` for query-specific columns (see outputSchema).',
  parametersSchema: '{"companyName": string, "companyDomain": string, "website"?: string, "emails": [{address,type?,confidence,name?,title?,department?,source?}], "phones": [{raw,normalized?,source?}], "topContact"?: {fullName,title?,seniority?}, "rankScore"?: number, "sources"?: [{url,type?}], "facts"?: {[key]: {value, unit?, sourceUrl?, confidence?, raw?}}, "reasoning"?: string}',
  handler: async (args, ctx) => {
    const companyName = String(args?.companyName ?? '').trim();
    const rawDomainRaw = String(args?.companyDomain ?? '').trim().toLowerCase().replace(/^www\./, '');
    if (!companyName) return { ok: false, output: 'companyName required' };

    // Reject placeholder domains the agent sometimes invents when it
    // can't find a real one. Carrying these through corrupts downstream
    // enrichment — Hunter will return data for whoever owns "unknown.com"
    // and attach it to the wrong company. An empty string is fine
    // (downstream knows to search for a real footprint), but a
    // misleading placeholder is not.
    const PLACEHOLDER_DOMAINS = new Set([
      'unknown.com', 'unknown.net', 'unknown.org',
      'example.com', 'example.org', 'example.net',
      'tbd.com', 'placeholder.com', 'none.com', 'na.com',
      'company.com', 'business.com', 'domain.com',
      'noemail.com', 'nowebsite.com',
    ]);
    // Reject webmail providers as company domains. The LLM-recall
    // sometimes proposes "gmail.com" as a company's domain when the
    // only contact it found was a free-tier @gmail address (typical
    // for solo Nigerian operators). Storing gmail.com as the
    // companyDomain would (a) collapse every gmail-only lead in a
    // workspace into one row via the unique-on-(workspace,domain)
    // index, (b) confuse the user reading the lead. Treat as
    // domain-less; the email itself is still preserved in lead.emails.
    const WEBMAIL_PROVIDERS = new Set([
      'gmail.com', 'googlemail.com',
      'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
      'hotmail.com', 'hotmail.co.uk', 'live.com', 'outlook.com', 'msn.com',
      'aol.com', 'aim.com',
      'icloud.com', 'me.com', 'mac.com',
      'protonmail.com', 'proton.me',
      'gmx.com', 'gmx.net', 'mail.com',
      'zoho.com',
      'yandex.com', 'yandex.ru',
    ]);
    const isJunkDomain = PLACEHOLDER_DOMAINS.has(rawDomainRaw) || WEBMAIL_PROVIDERS.has(rawDomainRaw);
    const rawDomain = isJunkDomain ? '' : rawDomainRaw;

    // Disambiguate social-platform leads so two influencers on
    // instagram.com don't collapse into one row. Empty domain → skip
    // identityDomain (no host to slug); use companyName as the dedup key.
    const companyDomain = rawDomain ? identityDomain(rawDomain, companyName) : '';

    // Same-domain handling — we support UPGRADES: a second write_lead on the same
    // domain can replace the prior record if the new one has strictly better data
    // (e.g. named topContact where previous was generic-only). This lets the agent
    // write baseline first and enrich later without fear of losing the baseline.
    // For domain-less leads, dedupe by companyName instead (case-insensitive).
    const existingIdx = companyDomain
      ? ctx.leadsSoFar.findIndex((l) => l.companyDomain === companyDomain)
      : ctx.leadsSoFar.findIndex((l) => !l.companyDomain && l.companyName.toLowerCase() === companyName.toLowerCase());
    const incomingHasNamedContact = !!(args?.topContact?.fullName && String(args.topContact.fullName).trim());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawEmailArgs: any[] = Array.isArray(args?.emails) ? args.emails : [];
    // Some models output email as facts.businessEmail (string) instead of emails[].
    // Rescue those before they get dropped by the facts schema filter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facts_raw = (args?.facts && typeof args.facts === 'object') ? args.facts as Record<string, any> : {};
    const rescuedEmail = facts_raw['businessEmail'];
    if (typeof rescuedEmail === 'string' && rescuedEmail.includes('@')) {
      rawEmailArgs.push({ address: rescuedEmail, type: 'business', confidence: 0.7, source: 'agent_extracted' });
    } else if (rescuedEmail && typeof rescuedEmail === 'object' && typeof rescuedEmail.value === 'string' && rescuedEmail.value.includes('@')) {
      rawEmailArgs.push({ address: rescuedEmail.value, type: 'business', confidence: 0.7, source: 'agent_extracted' });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emails = rawEmailArgs.map((e: any) => ({
      address: String(e.address ?? '').toLowerCase().trim(),
      type: (e.type ?? (e.name ? 'business' : 'generic')) as 'business' | 'generic',
      confidence: clampToFiniteNumber(e.confidence, 0.6, 0, 1),
      source: String(e.source ?? 'ai_extracted'),
      name: e.name ? String(e.name) : undefined,
      title: e.title ? String(e.title) : undefined,
      department: e.department ? String(e.department) : undefined,
    })).filter((e: { address: string }) => e.address.includes('@'));

    // Normalize phones through libphonenumber-js so downstream consumers get E.164 +
    // type classification (office/mobile/fax). Country hint comes from parsed intent
    // when present, else libphonenumber will try to infer from the number itself.
    const rawPhoneStrings: string[] = Array.isArray(args?.phones)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? args.phones.map((p: any) => String(p?.raw ?? p ?? '').trim()).filter(Boolean)
      : [];
    // Rescue officePhone from facts if model used wrong key
    const rescuedPhone = facts_raw['officePhone'];
    const rescuedPhoneStr = typeof rescuedPhone === 'string'
      ? rescuedPhone
      : (rescuedPhone && typeof rescuedPhone === 'object' && typeof rescuedPhone.value === 'string' ? rescuedPhone.value : '');
    if (rescuedPhoneStr) rawPhoneStrings.push(rescuedPhoneStr);
    const countryHint = countryNameToCode(ctx.parsedIntent.geography?.country);
    const normalized = normalizePhones(rawPhoneStrings, countryHint);
    const phones = normalized.map((p) => ({
      raw: p.raw,
      normalized: p.normalized,
      type: p.type,
      countryCode: p.countryCode,
      source: 'agent_extracted',
    })).filter((p) => p.raw);

    // Facts: query-specific payload fields. Only accept keys declared in the
    // job's outputSchema — silently drop anything else so agent hallucinations
    // don't leak into Mongo. Each value is clamped: `value` is preserved,
    // `confidence` forced to [0,1] finite, `sourceUrl` truncated to a sane size.
    const schemaKeys = new Set((ctx.parsedIntent.outputSchema ?? []).map((c) => c.key));
    const facts: Record<string, {
      value: string | number | boolean | string[] | null;
      unit?: string;
      sourceUrl?: string;
      confidence?: number;
      raw?: string;
    }> = {};
    for (const [k, v] of Object.entries(facts_raw)) {
      if (!schemaKeys.has(k)) {
        if (k !== 'businessEmail' && k !== 'officePhone') {
          logger.warn('[writeLead] fact key not in outputSchema — dropping', { companyName, key: k });
        }
        continue;
      }
      if (!v || typeof v !== 'object') continue;
      const value = v.value !== undefined ? v.value : null;
      const entry: {
        value: string | number | boolean | string[] | null;
        unit?: string;
        sourceUrl?: string;
        confidence?: number;
        raw?: string;
      } = { value };
      if (typeof v.unit === 'string') entry.unit = v.unit;
      if (typeof v.sourceUrl === 'string') entry.sourceUrl = v.sourceUrl.slice(0, 500);
      if (v.confidence !== undefined) {
        const c = clampToFiniteNumber(v.confidence, 0.6, 0, 1);
        entry.confidence = c;
      }
      if (typeof v.raw === 'string') entry.raw = v.raw.slice(0, 500);
      facts[k] = entry;
    }

    // schemaFulfillmentPct = (# of required schema keys present in facts)
    //                        / (# of required schema keys), or 1 if no required.
    const requiredKeys = (ctx.parsedIntent.outputSchema ?? []).filter((c) => c.required).map((c) => c.key);
    const schemaFulfillmentPct = requiredKeys.length === 0
      ? 1
      : requiredKeys.filter((k) => {
          const f = facts[k];
          return f !== undefined && f.value !== null && f.value !== '' && !(Array.isArray(f.value) && f.value.length === 0);
        }).length / requiredKeys.length;

    const lead: LeadRecord = {
      workspaceId: ctx.workspaceId,
      jobId: ctx.jobId,
      companyName,
      companyDomain,
      website: args?.website ? String(args.website) : `https://${companyDomain}`,
      industry: ctx.parsedIntent.industry ?? undefined,
      address: {
        country: ctx.parsedIntent.geography?.country ?? undefined,
        city: ctx.parsedIntent.geography?.city ?? undefined,
        state: ctx.parsedIntent.geography?.state ?? undefined,
      },
      emails,
      phones,
      socialProfiles: undefined,
      osint: { viaAgent: true } as Record<string, unknown>,
      ...(Object.keys(facts).length > 0 && { facts }),
      schemaFulfillmentPct,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sources: Array.isArray(args?.sources) ? args.sources.map((s: any) => ({
        url: String(s.url ?? ''),
        type: (s.type ?? 'scraped_page') as 'scraped_page',
        scrapedAt: new Date(),
        confidence: 0.6,
      })) : [],
      rawSnippets: [],
      rankScore: clampToFiniteNumber(args?.rankScore, 70, 0, 100),
      completenessScore: 0,
      isDuplicate: false,
      // Persist the agent's "why I'm writing this" string onto the
      // lead record. The grader's qualificationReason covers "why it
      // qualified" post-hoc; agentReasoning covers "why I collected
      // it" at commit-time. Both surface in the UI drawer.
      ...(typeof args?.reasoning === 'string' && args.reasoning.trim()
        ? { agentReasoning: args.reasoning.trim().slice(0, 2000) }
        : {}),
      tags: ['agent_emitted'],
      contactSummary: (() => {
        const rawName = args?.topContact?.fullName ? String(args.topContact.fullName) : undefined;
        if (!rawName || !looksLikePersonName(rawName)) {
          if (rawName) logger.warn('[writeLead] rejected implausible topContact name', { companyName, rawName: rawName.slice(0, 80) });
          return undefined;
        }
        return {
          totalContacts: 1,
          topContact: {
            fullName: rawName.trim(),
            title: String(args?.topContact?.title ?? '').trim(),
            seniority: String(args?.topContact?.seniority ?? '').trim(),
          },
        };
      })(),
    };

    // Upgrade logic: if same domain already written, merge emails/phones and
    // replace the record only if the new one adds named-contact data. Otherwise
    // silently skip (no duplicate rows in leadsSoFar).
    let writeAction: 'new' | 'upgrade' | 'merge' | 'skip' = 'new';
    if (existingIdx >= 0) {
      const existing = ctx.leadsSoFar[existingIdx]!;
      const existingHasNamedContact = !!existing.contactSummary?.topContact?.fullName;

      // Merge email/phone arrays (dedupe by address / raw).
      const mergedEmails = [...existing.emails];
      for (const ne of lead.emails) {
        if (!mergedEmails.some((e) => e.address === ne.address)) mergedEmails.push(ne);
      }
      const mergedPhones = [...existing.phones];
      for (const np of lead.phones) {
        if (!mergedPhones.some((p) => (p.normalized ?? p.raw) === (np.normalized ?? np.raw))) mergedPhones.push(np);
      }

      if (incomingHasNamedContact && !existingHasNamedContact) {
        // Strict upgrade — replace with new lead but keep merged contact arrays.
        ctx.leadsSoFar[existingIdx] = { ...lead, emails: mergedEmails, phones: mergedPhones };
        writeAction = 'upgrade';
      } else if (mergedEmails.length > existing.emails.length || mergedPhones.length > existing.phones.length) {
        // Merge only — add new emails/phones to existing record.
        existing.emails = mergedEmails;
        existing.phones = mergedPhones;
        writeAction = 'merge';
      } else {
        writeAction = 'skip';
      }
    } else {
      ctx.leadsSoFar.push(lead);
    }

    await ctx.publisher.publish(
      `job:progress:${ctx.jobId}`,
      JSON.stringify({ type: 'progress', leadsFoundSoFar: ctx.leadsSoFar.length }),
    );
    // `step` name maps to the frontend's tone classifier so the event
    // renders with the right color (positive for new/upgrade, muted for
    // merge/skip). Using the canonical jobActivity helper persists the
    // entry to Mongo `activityLog` for bootstrap-on-reconnect too.
    const stepName =
      writeAction === 'new' ? 'lead_written'
      : writeAction === 'upgrade' ? 'lead_upserted'
      : writeAction === 'merge' ? 'lead_merged'
      : 'duplicate_skipped';
    const verb =
      writeAction === 'new' ? 'Emitted'
      : writeAction === 'upgrade' ? 'Upgraded'
      : writeAction === 'merge' ? 'Merged'
      : 'Skipped (dup)';
    await jobActivity(
      ctx.jobId,
      ctx.publisher,
      stepName,
      `${verb}: ${companyName}`,
      {
        domain: companyDomain,
        emails: emails.length,
        phones: phones.length,
        action: writeAction,
        reasoning: args?.reasoning,
      },
    );

    logger.info('[writeLead] lead %s', writeAction, {
      jobId: ctx.jobId, companyName, companyDomain, emailCount: emails.length, phoneCount: phones.length, action: writeAction,
    });

    return {
      ok: true,
      output: JSON.stringify({
        action: writeAction,
        totalLeadsSoFar: ctx.leadsSoFar.length,
        targetCount: ctx.parsedIntent.targetCount,
        hint: writeAction === 'new'
          ? 'Baseline lead written. If budget allows, consider enriching with a team-page search to find a named decision-maker, then call write_lead again on the same domain to upgrade.'
          : writeAction === 'upgrade'
            ? 'Existing lead upgraded with named contact. Move on to the next company.'
            : writeAction === 'merge'
              ? 'Existing lead had additional emails/phones merged in. Move on to the next company.'
              : 'Incoming data was not strictly better than existing lead. Move on.',
      }),
    };
  },
};
