import { z } from 'zod';
import { registerDataSource } from '../registry.js';
import { providerFetch } from '../http.js';

/**
 * Apollo.io — People Match (`POST /v1/people/match`).
 *
 * Given identifying fields (email OR domain+name OR LinkedIn URL), returns
 * a single matched person record with title, company, verified email,
 * phone, LinkedIn, seniority, etc. The core "enrich a person" endpoint
 * in Apollo's API.
 *
 * Auth: X-Api-Key header. Master API key issued by Apollo per workspace
 * (BYOK — customer's own paid account).
 *
 * Pricing: Apollo bills per matched record in credits; export credits are
 * distinct from email credits. We record 1 invocation per call regardless
 * of Apollo's internal credit accounting — the customer's Apollo dashboard
 * is the source of truth for Apollo spend. Our `providerCostUSDPerCall` is
 * an estimate for our own margin tracking (1 Apollo export credit ≈ $0.02
 * at common pro-tier pricing).
 *
 * Docs: https://docs.apollo.io/reference/people-enrichment
 */

const BASE_URL = 'https://api.apollo.io/v1';

const inputSchema = z.object({
  email: z.string().email().optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  name: z.string().max(200).optional(),
  domain: z.string().max(255).optional(),
  organizationName: z.string().max(255).optional(),
  linkedinUrl: z.string().url().optional(),
  revealPersonalEmails: z.boolean().default(false),
  revealPhoneNumber: z.boolean().default(false),
}).refine(
  (d) =>
    Boolean(d.email) ||
    Boolean(d.linkedinUrl) ||
    (Boolean(d.firstName) && Boolean(d.lastName) && (Boolean(d.domain) || Boolean(d.organizationName))) ||
    (Boolean(d.name) && (Boolean(d.domain) || Boolean(d.organizationName))),
  {
    message:
      'Must provide one of: email, linkedinUrl, (firstName + lastName + (domain | organizationName)), or (name + (domain | organizationName))',
  },
);

// Apollo's response is huge and denormalized. We pick the fields a table/
// column would realistically use; unknown fields pass through as `raw`
// for the invocation log and future waterfall logic.
const outputSchema = z.object({
  matched: z.boolean(),
  person: z.object({
    id: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    headline: z.string().optional(),
    email: z.string().optional(),
    emailStatus: z.string().optional(),    // 'verified' | 'unverified' | etc.
    phoneNumber: z.string().optional(),
    linkedinUrl: z.string().optional(),
    twitterUrl: z.string().optional(),
    facebookUrl: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    seniority: z.string().optional(),       // 'senior', 'c_suite', 'vp', etc.
    departments: z.array(z.string()).optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    organizationDomain: z.string().optional(),
  }).optional(),
  raw: z.unknown().optional(),
});

registerDataSource({
  id: 'apollo.people_match',
  name: 'Apollo — Person Match',
  description:
    'Enrich a single person record from Apollo.io. Input by email, LinkedIn URL, or name+company. Returns verified email, phone, title, seniority, LinkedIn, and organization context. Requires an Apollo API key.',
  category: 'person_enrichment',
  version: 1,

  auth: {
    type: 'api_key',
    fields: [
      {
        key: 'apiKey',
        label: 'Apollo API key',
        secret: true,
        hint: 'Find under Apollo Settings → Integrations → API. Master API key.',
      },
    ],
    testFn: async (creds) => {
      // Cheapest probe: /auth/health returns 200 for a valid key with no credit burn.
      try {
        await providerFetch(`${BASE_URL}/auth/health`, {
          method: 'GET',
          headers: { 'X-Api-Key': creds.apiKey ?? '' },
          timeoutMs: 10_000,
        });
        return { ok: true, message: 'Apollo API key verified.' };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  },

  input: {
    schema: inputSchema,
    describe: [
      { key: 'email', label: 'Email', required: false, hint: 'Highest match confidence if provided.' },
      { key: 'linkedinUrl', label: 'LinkedIn URL', required: false },
      { key: 'firstName', label: 'First name', required: false },
      { key: 'lastName', label: 'Last name', required: false },
      { key: 'name', label: 'Full name', required: false, hint: 'Alternative to firstName + lastName.' },
      { key: 'domain', label: 'Company domain', required: false, hint: 'Required with name-only match.' },
      { key: 'organizationName', label: 'Company name', required: false },
      { key: 'revealPersonalEmails', label: 'Reveal personal emails', required: false, hint: 'Costs extra Apollo credits.' },
      { key: 'revealPhoneNumber', label: 'Reveal phone', required: false, hint: 'Costs extra Apollo credits.' },
    ],
  },

  output: {
    schema: outputSchema,
    describe: [
      { key: 'matched', label: 'Matched', type: 'boolean' },
      { key: 'person.email', label: 'Email', type: 'email' },
      { key: 'person.emailStatus', label: 'Email status', type: 'string' },
      { key: 'person.phoneNumber', label: 'Phone', type: 'phone' },
      { key: 'person.title', label: 'Title', type: 'string' },
      { key: 'person.seniority', label: 'Seniority', type: 'string' },
      { key: 'person.linkedinUrl', label: 'LinkedIn', type: 'url' },
      { key: 'person.organizationName', label: 'Company', type: 'string' },
      { key: 'person.organizationDomain', label: 'Company domain', type: 'string' },
      { key: 'person.country', label: 'Country', type: 'string' },
    ],
  },

  pricing: {
    model: 'byok',
    providerCostUSDPerCall: 0.02,  // Apollo Pro tier estimate; customer's own credits burn on their side
    notes:
      'BYOK — Apollo bills the customer in credits against their own plan. Our cost estimate is for internal margin tracking only.',
  },

  // Apollo's published rate limit is 120 requests/minute for the master key.
  // We set slightly lower to leave headroom for the customer's other integrations.
  rateLimit: { perMinute: 100, perDay: 10_000 },

  handler: async (input, creds) => {
    if (!creds?.apiKey) throw new Error('Apollo API key missing');
    const body: Record<string, unknown> = {};
    if (input.email) body.email = input.email;
    if (input.firstName) body.first_name = input.firstName;
    if (input.lastName) body.last_name = input.lastName;
    if (input.name) body.name = input.name;
    if (input.domain) body.domain = input.domain;
    if (input.organizationName) body.organization_name = input.organizationName;
    if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
    if (input.revealPersonalEmails) body.reveal_personal_emails = true;
    if (input.revealPhoneNumber) body.reveal_phone_number = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await providerFetch<any>(`${BASE_URL}/people/match`, {
      method: 'POST',
      headers: { 'X-Api-Key': creds.apiKey },
      body,
    });

    const p = res.data?.person;
    if (!p) return { matched: false, raw: res.data };

    return {
      matched: true,
      person: {
        id: p.id,
        firstName: p.first_name,
        lastName: p.last_name,
        name: p.name,
        title: p.title,
        headline: p.headline,
        email: p.email,
        emailStatus: p.email_status,
        phoneNumber: p.phone_number ?? p.sanitized_phone,
        linkedinUrl: p.linkedin_url,
        twitterUrl: p.twitter_url,
        facebookUrl: p.facebook_url,
        city: p.city,
        state: p.state,
        country: p.country,
        seniority: p.seniority,
        departments: p.departments,
        organizationId: p.organization?.id,
        organizationName: p.organization?.name,
        organizationDomain: p.organization?.primary_domain,
      },
      raw: res.data,
    };
  },
});
