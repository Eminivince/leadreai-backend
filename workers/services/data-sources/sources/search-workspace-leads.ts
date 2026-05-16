import { z } from 'zod';
import mongoose, { Schema } from 'mongoose';
import { registerWorkerDataSource } from '../registry.js';

/**
 * search_workspace_leads — queries the workspace's accumulated Lead
 * records to see what we already know before spending on SERP / scrape.
 *
 * Commercial rationale: the workspace compounds knowledge over time.
 * Running "top Nigerian fintechs" twice in one month should not pay
 * for the same discovery twice. This source returns up-to-N matches
 * with enough fields that the agent can skip rediscovery and go
 * straight to verification / enrichment deltas.
 *
 * Ordering in the agent's cost hierarchy: this is cheaper than
 * `list_companies` (which hits Wikipedia + curated seed lists) and
 * WAY cheaper than `search_web`. Sits at position #2 after
 * `read_document` (which is free + zero-latency for Library hits).
 *
 * Retrieval strategy:
 *   - AND on workspaceId (hard tenancy)
 *   - optional industry / country / city matches (case-insensitive)
 *   - optional $text search on name+description (rides existing index)
 *   - exclude leads marked isDuplicate
 *   - sort by text score → rankScore → updatedAt
 *   - cap at maxResults (1-50, default 20)
 */

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;

const inputSchema = z.object({
  industry: z.string().max(200).optional(),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  keywords: z.string().max(500).optional(),
  /** Only surface leads where at least one email has `verified:true`. */
  verifiedOnly: z.boolean().default(false),
  /** Minimum rank score (0-100). Filters low-quality carryover. */
  minRankScore: z.number().int().min(0).max(100).default(0),
  maxResults: z.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
}).refine(
  (d) => Boolean(d.industry) || Boolean(d.country) || Boolean(d.keywords),
  { message: 'Must provide at least one of: industry, country, keywords' },
);

const outputSchema = z.object({
  totalMatched: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  leads: z.array(z.object({
    _id: z.string(),
    companyName: z.string(),
    companyDomain: z.string().optional(),
    website: z.string().optional(),
    industry: z.string().optional(),
    country: z.string().optional(),
    city: z.string().optional(),
    rankScore: z.number(),
    hasEmail: z.boolean(),
    hasPhone: z.boolean(),
    hasVerifiedEmail: z.boolean(),
    topContactName: z.string().optional(),
    topContactTitle: z.string().optional(),
    lastUpdatedAt: z.string(),
  })),
});

// Inline minimal Lead model — same collection as the backend model.
// strict:false so queries pass through untouched fields the backend model
// validates. We only read here; upserts happen through the existing
// leadWriter pipeline.
const leadSchema = new Schema(
  {
    workspaceId: Schema.Types.ObjectId,
    companyName: String,
    companyDomain: String,
    website: String,
    industry: String,
    address: { country: String, city: String },
    emails: [{ address: String, verified: Boolean }],
    phones: [{ raw: String }],
    rankScore: Number,
    isDuplicate: Boolean,
    contactSummary: Schema.Types.Mixed,
    updatedAt: Date,
  },
  { strict: false },
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LeadModel: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', leadSchema, 'leads');

registerWorkerDataSource({
  id: 'search_workspace_leads',
  name: 'Workspace leads (accumulated)',
  description:
    'Search leads this workspace has already researched. Cheaper than SERP and way cheaper than scraping — call this FIRST for any demographic / industry query to reuse prior work. Returns up to 20 best matches with rank + email/phone flags.',
  category: 'library',
  version: 1,

  input: {
    schema: inputSchema,
    describe: [
      { key: 'industry', label: 'Industry', required: false, hint: 'Matched case-insensitive against Lead.industry.' },
      { key: 'country', label: 'Country', required: false, hint: 'Matched against Lead.address.country.' },
      { key: 'city', label: 'City', required: false },
      { key: 'keywords', label: 'Keywords', required: false, hint: 'Full-text search over name + description.' },
      { key: 'verifiedOnly', label: 'Verified emails only', required: false },
      { key: 'minRankScore', label: 'Minimum rank (0-100)', required: false },
      { key: 'maxResults', label: 'Max results (1-50)', required: false },
    ],
  },

  output: {
    schema: outputSchema,
    describe: [
      { key: 'totalMatched', label: 'Total matched', type: 'number' },
      { key: 'leads[].companyName', label: 'Company', type: 'string' },
      { key: 'leads[].companyDomain', label: 'Domain', type: 'string' },
      { key: 'leads[].industry', label: 'Industry', type: 'string' },
      { key: 'leads[].country', label: 'Country', type: 'string' },
      { key: 'leads[].rankScore', label: 'Rank score', type: 'number' },
      { key: 'leads[].hasEmail', label: 'Has email', type: 'boolean' },
      { key: 'leads[].hasVerifiedEmail', label: 'Verified email', type: 'boolean' },
      { key: 'leads[].topContactName', label: 'Top contact', type: 'string' },
    ],
  },

  handler: async (input, ctx) => {
    // Hard tenancy — workspaceId is non-negotiable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: Record<string, any> = {
      workspaceId: new mongoose.Types.ObjectId(ctx.workspaceId),
      isDuplicate: { $ne: true },
    };

    if (input.industry) {
      filter['industry'] = { $regex: `^${escapeRegex(input.industry)}$`, $options: 'i' };
    }
    if (input.country) {
      filter['address.country'] = { $regex: `^${escapeRegex(input.country)}$`, $options: 'i' };
    }
    if (input.city) {
      filter['address.city'] = { $regex: `^${escapeRegex(input.city)}$`, $options: 'i' };
    }
    const minRank = input.minRankScore ?? 0;
    if (minRank > 0) {
      filter['rankScore'] = { $gte: minRank };
    }

    const limit = input.maxResults ?? LIMIT_DEFAULT;
    const trimmedKeywords = input.keywords?.trim() ?? '';

    // Mongo text search — project text score + sort by it first when present.
    const query = trimmedKeywords
      ? LeadModel.find({ ...filter, $text: { $search: trimmedKeywords } })
          .select({ score: { $meta: 'textScore' } })
          .sort({ score: { $meta: 'textScore' }, rankScore: -1 })
      : LeadModel.find(filter).sort({ rankScore: -1, updatedAt: -1 });

    const rows = await query.limit(limit).lean();

    // Verified-only filter applied post-query — easier than an $elemMatch
    // over the whole emails[] array; cardinality bounded by `limit`.
    const leads = rows
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((l: any) => {
        if (!input.verifiedOnly) return true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Array.isArray(l.emails) && l.emails.some((e: any) => e?.verified === true);
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((l: any) => ({
        _id: String(l._id),
        companyName: String(l.companyName ?? ''),
        companyDomain: l.companyDomain,
        website: l.website,
        industry: l.industry,
        country: l.address?.country,
        city: l.address?.city,
        rankScore: typeof l.rankScore === 'number' ? l.rankScore : 0,
        hasEmail: Array.isArray(l.emails) && l.emails.length > 0,
        hasPhone: Array.isArray(l.phones) && l.phones.length > 0,
        hasVerifiedEmail:
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          Array.isArray(l.emails) && l.emails.some((e: any) => e?.verified === true),
        topContactName: l.contactSummary?.topContact?.fullName,
        topContactTitle: l.contactSummary?.topContact?.title,
        lastUpdatedAt: l.updatedAt ? new Date(l.updatedAt).toISOString() : new Date().toISOString(),
      }));

    return {
      totalMatched: leads.length,
      returned: leads.length,
      leads,
    };
  },
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
