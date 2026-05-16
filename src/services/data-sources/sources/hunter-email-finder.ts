import { z } from 'zod';
import { registerDataSource } from '../registry.js';
import { providerFetch } from '../http.js';

/**
 * Hunter.io — Email Finder (`GET /v2/email-finder`).
 *
 * Given a domain + full name (or first_name + last_name), returns the
 * most-likely work email plus Hunter's confidence score + the underlying
 * sources they found the email on.
 *
 * Hunter's coverage is weaker than Apollo for niche markets but is often
 * cheaper per call and doesn't require Apollo's minimum plan. Good as a
 * primary for some workspaces, good as a secondary in waterfalls (v2).
 *
 * Docs: https://hunter.io/api-documentation/v2#email-finder
 */

const BASE_URL = 'https://api.hunter.io/v2';

const inputSchema = z.object({
  domain: z.string().min(3).max(255).optional(),
  company: z.string().max(255).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  fullName: z.string().max(200).optional(),
  maxDuration: z.number().int().min(3).max(20).default(10),
}).refine(
  (d) =>
    (Boolean(d.domain) || Boolean(d.company)) &&
    (Boolean(d.fullName) || (Boolean(d.firstName) && Boolean(d.lastName))),
  {
    message: 'Must provide (domain OR company) AND (fullName OR firstName+lastName).',
  },
);

const outputSchema = z.object({
  email: z.string().optional(),
  score: z.number().optional(),              // Hunter's confidence 0-100
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  position: z.string().optional(),
  linkedinUrl: z.string().optional(),
  twitterHandle: z.string().optional(),
  phoneNumber: z.string().optional(),
  company: z.string().optional(),
  verification: z.object({
    status: z.string().optional(),            // 'valid' | 'accept_all' | 'unknown' | 'invalid'
    date: z.string().optional(),
  }).optional(),
  sources: z.array(z.object({
    domain: z.string().optional(),
    uri: z.string().optional(),
    extractedOn: z.string().optional(),
    lastSeenOn: z.string().optional(),
  })).optional(),
  raw: z.unknown().optional(),
});

registerDataSource({
  id: 'hunter.email_finder',
  name: 'Hunter — Email Finder',
  description:
    'Find the most-likely work email for a person at a company. Input by domain+name. Returns email, Hunter confidence score, and the public pages Hunter saw it on.',
  category: 'email_finder',
  version: 1,

  auth: {
    type: 'api_key',
    fields: [
      {
        key: 'apiKey',
        label: 'Hunter API key',
        secret: true,
        hint: 'Hunter Dashboard → API. Same key for all Hunter endpoints.',
      },
    ],
    testFn: async (creds) => {
      // /account is free + unmetered — verifies the key without burning credit.
      try {
        await providerFetch(`${BASE_URL}/account`, {
          query: { api_key: creds.apiKey ?? '' },
          timeoutMs: 10_000,
        });
        return { ok: true, message: 'Hunter API key verified.' };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  },

  input: {
    schema: inputSchema,
    describe: [
      { key: 'domain', label: 'Domain', required: false, hint: 'Bare domain, e.g. "stripe.com".' },
      { key: 'company', label: 'Company name', required: false, hint: 'Alternative to domain.' },
      { key: 'firstName', label: 'First name', required: false },
      { key: 'lastName', label: 'Last name', required: false },
      { key: 'fullName', label: 'Full name', required: false, hint: 'Alternative to firstName + lastName.' },
      { key: 'maxDuration', label: 'Max duration (s)', required: false, hint: '3–20. Hunter spends up to this long searching.' },
    ],
  },

  output: {
    schema: outputSchema,
    describe: [
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'score', label: 'Confidence', type: 'number' },
      { key: 'position', label: 'Position', type: 'string' },
      { key: 'linkedinUrl', label: 'LinkedIn', type: 'url' },
      { key: 'verification.status', label: 'Verification', type: 'string' },
      { key: 'company', label: 'Company', type: 'string' },
    ],
  },

  pricing: {
    model: 'byok',
    providerCostUSDPerCall: 0.0, // Hunter's plan is monthly-request-capped, not per-call
    notes: 'BYOK — Hunter caps monthly searches by plan. 1 call = 1 search regardless of result.',
  },

  rateLimit: { perMinute: 30, perDay: 1000 },

  handler: async (input, creds) => {
    if (!creds?.apiKey) throw new Error('Hunter API key missing');

    const query: Record<string, string | number | undefined> = {
      api_key: creds.apiKey,
      domain: input.domain,
      company: input.company,
      first_name: input.firstName,
      last_name: input.lastName,
      full_name: input.fullName,
      max_duration: input.maxDuration,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await providerFetch<any>(`${BASE_URL}/email-finder`, { query });

    const d = res.data?.data;
    if (!d) return { raw: res.data };

    return {
      email: d.email,
      score: d.score,
      firstName: d.first_name,
      lastName: d.last_name,
      position: d.position,
      linkedinUrl: d.linkedin_url,
      twitterHandle: d.twitter,
      phoneNumber: d.phone_number,
      company: d.company,
      verification: d.verification
        ? { status: d.verification.status, date: d.verification.date }
        : undefined,
      sources: Array.isArray(d.sources)
        ? d.sources.map((s: Record<string, string>) => ({
            domain: s.domain,
            uri: s.uri,
            extractedOn: s.extracted_on,
            lastSeenOn: s.last_seen_on,
          }))
        : undefined,
      raw: res.data,
    };
  },
});
