import { z } from 'zod';
import { registerDataSource } from '../registry.js';
import { providerFetch } from '../http.js';

/**
 * Apollo.io — Organization Enrichment (`GET /v1/organizations/enrich`).
 *
 * Given a company domain, returns the org's Apollo record: industry,
 * employee count, funding info, social profiles, keywords, estimated
 * revenue range, tech stack. The company-side counterpart to people_match.
 *
 * Auth + BYOK pricing match `apollo.people_match`. Same API key unlocks both.
 *
 * Docs: https://docs.apollo.io/reference/organization-enrichment
 */

const BASE_URL = 'https://api.apollo.io/v1';

const inputSchema = z.object({
  domain: z.string().min(3).max(255),
});

const outputSchema = z.object({
  matched: z.boolean(),
  organization: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    websiteUrl: z.string().optional(),
    primaryDomain: z.string().optional(),
    linkedinUrl: z.string().optional(),
    twitterUrl: z.string().optional(),
    facebookUrl: z.string().optional(),
    industry: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    estimatedNumEmployees: z.number().optional(),
    annualRevenuePrinted: z.string().optional(),     // e.g. "$50M"
    totalFundingPrinted: z.string().optional(),
    latestFundingRoundDate: z.string().optional(),
    latestFundingStage: z.string().optional(),
    foundedYear: z.number().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    phone: z.string().optional(),
    technologyNames: z.array(z.string()).optional(), // detected tech stack
  }).optional(),
  raw: z.unknown().optional(),
});

registerDataSource({
  id: 'apollo.organization_enrich',
  name: 'Apollo — Organization Enrichment',
  description:
    'Enrich a company by domain. Returns industry, employee count, funding stage + amount, tech stack, social profiles, headquarters. Requires an Apollo API key.',
  category: 'company_enrichment',
  version: 1,

  auth: {
    type: 'api_key',
    fields: [
      { key: 'apiKey', label: 'Apollo API key', secret: true, hint: 'Same key as Apollo — Person Match.' },
    ],
    testFn: async (creds) => {
      try {
        await providerFetch(`${BASE_URL}/auth/health`, {
          method: 'GET',
          headers: { 'X-Api-Key': creds.apiKey ?? '' },
          timeoutMs: 10_000,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  },

  input: {
    schema: inputSchema,
    describe: [
      { key: 'domain', label: 'Company domain', required: true, hint: 'Bare domain, e.g. "paystack.com".' },
    ],
  },

  output: {
    schema: outputSchema,
    describe: [
      { key: 'matched', label: 'Matched', type: 'boolean' },
      { key: 'organization.name', label: 'Company name', type: 'string' },
      { key: 'organization.industry', label: 'Industry', type: 'string' },
      { key: 'organization.estimatedNumEmployees', label: 'Employees', type: 'number' },
      { key: 'organization.annualRevenuePrinted', label: 'Revenue', type: 'string' },
      { key: 'organization.totalFundingPrinted', label: 'Total funding', type: 'string' },
      { key: 'organization.latestFundingStage', label: 'Latest round', type: 'string' },
      { key: 'organization.linkedinUrl', label: 'LinkedIn', type: 'url' },
      { key: 'organization.technologyNames', label: 'Tech stack', type: 'tags' },
      { key: 'organization.country', label: 'Country', type: 'string' },
    ],
  },

  pricing: {
    model: 'byok',
    providerCostUSDPerCall: 0.01,
    notes: 'BYOK — Apollo bills per lookup against the customer plan.',
  },

  rateLimit: { perMinute: 100, perDay: 10_000 },

  handler: async (input, creds) => {
    if (!creds?.apiKey) throw new Error('Apollo API key missing');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await providerFetch<any>(`${BASE_URL}/organizations/enrich`, {
      method: 'GET',
      headers: { 'X-Api-Key': creds.apiKey },
      query: { domain: input.domain },
    });

    const o = res.data?.organization;
    if (!o) return { matched: false, raw: res.data };

    return {
      matched: true,
      organization: {
        id: o.id,
        name: o.name,
        websiteUrl: o.website_url,
        primaryDomain: o.primary_domain,
        linkedinUrl: o.linkedin_url,
        twitterUrl: o.twitter_url,
        facebookUrl: o.facebook_url,
        industry: o.industry,
        keywords: o.keywords,
        estimatedNumEmployees: o.estimated_num_employees,
        annualRevenuePrinted: o.annual_revenue_printed,
        totalFundingPrinted: o.total_funding_printed,
        latestFundingRoundDate: o.latest_funding_round_date,
        latestFundingStage: o.latest_funding_stage,
        foundedYear: o.founded_year,
        city: o.city,
        state: o.state,
        country: o.country,
        phone: o.phone,
        technologyNames: o.current_technologies?.map?.((t: { name: string }) => t.name),
      },
      raw: res.data,
    };
  },
});
