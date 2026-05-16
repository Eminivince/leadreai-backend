import { z } from 'zod';
import { registerDataSource } from '../registry.js';
import { providerFetch } from '../http.js';

/**
 * ZeroBounce — Email Verification (`GET /v2/validate`).
 *
 * Complements our existing built-in `verify_email` (syntax + MX + SMTP RCPT).
 * ZeroBounce adds:
 *   - Catch-all domain detection (our v1 can't do this — see the v2
 *     roadmap's Remaining Gaps #1)
 *   - Role-based flag (info@, admin@, sales@ detection for campaign filtering)
 *   - Disposable-email flag (sneak through spam filters)
 *   - Toxic-domain flag (spamtrap, known-bad lists)
 *
 * Workspaces with both the built-in verifier and ZeroBounce enabled get
 * "catch-all-aware" verification — a meaningful quality win over the
 * current broken-SMTP-probe-returns-"unknown" fallback.
 *
 * Docs: https://www.zerobounce.net/docs/email-validation-api-quickstart/
 */

const BASE_URL = 'https://api.zerobounce.net/v2';

const inputSchema = z.object({
  email: z.string().email(),
  ipAddress: z.string().max(45).optional(),   // optional — improves scoring for B2C but unused B2B
});

const outputSchema = z.object({
  address: z.string(),
  status: z.string(),          // 'valid' | 'invalid' | 'catch-all' | 'unknown' | 'spamtrap' | 'abuse' | 'do_not_mail'
  subStatus: z.string().optional(),
  freeEmail: z.boolean().optional(),
  didYouMean: z.string().optional(),
  account: z.string().optional(),
  domain: z.string().optional(),
  domainAgeDays: z.number().optional(),
  smtpProvider: z.string().optional(),
  mxRecord: z.string().optional(),
  mxFound: z.boolean().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  gender: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  zipCode: z.string().optional(),
  processedAt: z.string().optional(),
  raw: z.unknown().optional(),
});

registerDataSource({
  id: 'zerobounce.verify',
  name: 'ZeroBounce — Email Verify',
  description:
    'Production-grade email verification. Adds catch-all detection, disposable / role / spamtrap flags, and free-email detection beyond our built-in MX+SMTP probe.',
  category: 'email_verify',
  version: 1,

  auth: {
    type: 'api_key',
    fields: [
      {
        key: 'apiKey',
        label: 'ZeroBounce API key',
        secret: true,
        hint: 'Account → API. Used for all ZeroBounce endpoints.',
      },
    ],
    testFn: async (creds) => {
      // /getcredits returns the account balance — free + unmetered.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await providerFetch<any>(`${BASE_URL}/getcredits`, {
          query: { api_key: creds.apiKey ?? '' },
          timeoutMs: 10_000,
        });
        const credits = Number(res.data?.Credits ?? -1);
        if (credits < 0) return { ok: false, message: 'ZeroBounce returned no credit balance — key likely invalid.' };
        return { ok: true, message: `ZeroBounce key verified. ${credits.toLocaleString()} credits available.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  },

  input: {
    schema: inputSchema,
    describe: [
      { key: 'email', label: 'Email', required: true },
      {
        key: 'ipAddress',
        label: 'IP address',
        required: false,
        hint: 'Optional IP the address was submitted from. Usually unused for B2B.',
      },
    ],
  },

  output: {
    schema: outputSchema,
    describe: [
      { key: 'address', label: 'Email', type: 'email' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'subStatus', label: 'Sub status', type: 'string' },
      { key: 'freeEmail', label: 'Free email', type: 'boolean' },
      { key: 'didYouMean', label: 'Did you mean', type: 'email' },
      { key: 'domainAgeDays', label: 'Domain age (days)', type: 'number' },
      { key: 'mxFound', label: 'MX found', type: 'boolean' },
      { key: 'smtpProvider', label: 'SMTP provider', type: 'string' },
    ],
  },

  pricing: {
    model: 'byok',
    providerCostUSDPerCall: 0.0075, // ~$0.00075 per credit at low volume; rough estimate
    notes: 'BYOK — ZeroBounce bills per validation against the customer plan.',
  },

  // ZeroBounce doesn't publish a per-plan rate limit — the limit is effectively
  // credit balance. We enforce a conservative burst cap to prevent runaway jobs.
  rateLimit: { perMinute: 300 },

  handler: async (input, creds) => {
    if (!creds?.apiKey) throw new Error('ZeroBounce API key missing');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await providerFetch<any>(`${BASE_URL}/validate`, {
      query: {
        api_key: creds.apiKey,
        email: input.email,
        ip_address: input.ipAddress ?? '',
      },
    });

    const d = res.data ?? {};
    return {
      address: d.address ?? input.email,
      status: d.status ?? 'unknown',
      subStatus: d.sub_status,
      freeEmail: typeof d.free_email === 'boolean' ? d.free_email : undefined,
      didYouMean: d.did_you_mean,
      account: d.account,
      domain: d.domain,
      domainAgeDays: d.domain_age_days !== null && d.domain_age_days !== undefined
        ? Number(d.domain_age_days)
        : undefined,
      smtpProvider: d.smtp_provider,
      mxRecord: d.mx_record,
      mxFound: typeof d.mx_found === 'boolean' ? d.mx_found : undefined,
      firstName: d.firstname,
      lastName: d.lastname,
      gender: d.gender,
      country: d.country,
      region: d.region,
      city: d.city,
      zipCode: d.zipcode,
      processedAt: d.processed_at,
      raw: res.data,
    };
  },
});
