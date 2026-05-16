import { z } from 'zod';
import { COST_CATEGORIES } from './cost.schemas.js';

/**
 * Data Source Platform — Phase 15A.
 *
 * A DataSource is a named, typed, observable external-or-internal data
 * provider. Built-ins (search_web, fetch_url, scrape_page, verify_email,
 * etc.) migrate onto this shape in 15A. External integrations (Apollo,
 * Hunter, ZeroBounce) land on it in 15B. Tables + column-referenced
 * enrichment land on it in 15C/15D.
 *
 * This file is data-only — the runtime `DataSource` definition (which
 * carries a handler function) lives in backend code. What's schematized
 * here is what crosses API / DB boundaries: credential shape, invocation
 * record shape, and the serializable view of a DataSource for listing.
 */

// ── Category enum — mostly a display/filter concept. ────────────────
export const DATA_SOURCE_CATEGORIES = [
  // Built-in / platform sources (our existing 14 tools)
  'search',            // search_web, list_companies, lookup_registry
  'fetch',             // fetch_url, fetch_file
  'scrape',            // scrape_page
  'audio',             // transcribe_url
  'library',           // read_document, search_workspace_leads
  'enrichment_builtin',// extract_names_from_urls, permute_email, verify_email
  'scoring',           // score_lead
  'writer',            // write_lead
  // External providers (Phase 15B+)
  'person_enrichment',
  'company_enrichment',
  'email_finder',
  'email_verify',
  'phone_verify',
  'phone_finder',
  'company_search',
  'person_search',
  'tech_stack',
  'intent_signal',
  'news',
  'funding',
  'hiring',
  'custom_http',
  'ai',
] as const;
export const DataSourceCategorySchema = z.enum(DATA_SOURCE_CATEGORIES);
export type DataSourceCategory = z.infer<typeof DataSourceCategorySchema>;

// ── Auth + pricing metadata, serialized to UI ────────────────────────
export const DATA_SOURCE_AUTH_TYPES = ['none', 'api_key', 'oauth2', 'basic', 'platform'] as const;
export const DataSourceAuthTypeSchema = z.enum(DATA_SOURCE_AUTH_TYPES);
export type DataSourceAuthType = z.infer<typeof DataSourceAuthTypeSchema>;

export const DataSourceAuthFieldSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  secret: z.boolean(),
  hint: z.string().max(200).optional(),
});

export const DataSourcePricingModelSchema = z.enum(['byok', 'metered', 'free']);

export const DataSourcePricingSchema = z.object({
  model: DataSourcePricingModelSchema,
  creditsPerCall: z.number().nonnegative().optional(),
  providerCostUSDPerCall: z.number().nonnegative().optional(),
  notes: z.string().max(300).optional(),
});

// ── Public (listable) view of a DataSource ───────────────────────────
// This is what the `GET /data-sources` endpoint returns. The actual
// runtime DataSource carries `input`, `output`, and `handler` which
// don't cross process boundaries.
export const DataSourceSummarySchema = z.object({
  id: z.string().min(1).max(100),                     // 'search_web', 'apollo.people_match'
  name: z.string().min(1).max(120),
  description: z.string().max(600),
  category: DataSourceCategorySchema,
  version: z.number().int().positive(),
  auth: z.object({
    type: DataSourceAuthTypeSchema,
    fields: z.array(DataSourceAuthFieldSchema).optional(),
  }),
  pricing: DataSourcePricingSchema,
  rateLimit: z.object({
    perMinute: z.number().int().positive().optional(),
    perDay: z.number().int().positive().optional(),
  }).optional(),
  // Input/output contracts surfaced to the UI as human-readable shapes
  // so tables can present "what can I pass in" and "what do I get out."
  inputFields: z.array(z.object({
    key: z.string(), label: z.string(), required: z.boolean(), hint: z.string().optional(),
  })),
  outputFields: z.array(z.object({
    key: z.string(), label: z.string(), type: z.string(),
  })),
});
export type DataSourceSummary = z.infer<typeof DataSourceSummarySchema>;

// ── Credential (workspace-scoped) ────────────────────────────────────
export const DataSourceCredentialSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  dataSourceId: z.string(),
  label: z.string().max(120).optional(),
  verifiedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
  lastErrorAt: z.string().optional(),
  lastErrorMessage: z.string().max(500).optional(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DataSourceCredential = z.infer<typeof DataSourceCredentialSchema>;

export const CreateCredentialInputSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
  // Dynamic keys — validated against the DataSource's auth.fields at runtime.
  fields: z.record(z.string(), z.string().max(4000)),
});
export type CreateCredentialInput = z.infer<typeof CreateCredentialInputSchema>;

// ── Invocation record ────────────────────────────────────────────────
export const INVOCATION_STATUSES = [
  'pending',
  'success',
  'failed',
  'rate_limited',
  'auth_failed',
  'invalid_input',
] as const;
export const InvocationStatusSchema = z.enum(INVOCATION_STATUSES);
export type InvocationStatus = z.infer<typeof InvocationStatusSchema>;

export const INVOCATION_TRIGGERS = [
  'agent',
  'manual',
  'waterfall',
  'scheduled',
  'system',
] as const;
export const InvocationTriggerSchema = z.enum(INVOCATION_TRIGGERS);
export type InvocationTrigger = z.infer<typeof InvocationTriggerSchema>;

export const DataSourceInvocationSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  dataSourceId: z.string(),
  credentialId: z.string().optional(),
  triggeredBy: InvocationTriggerSchema,
  parentJobId: z.string().optional(),
  parentLeadId: z.string().optional(),
  parentTableRowId: z.string().optional(),
  parentColumnKey: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).optional(),
  status: InvocationStatusSchema,
  errorMessage: z.string().max(1000).optional(),
  latencyMs: z.number().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
  /** Which CostCategory the cost rolled up into. Allows joining invocation
   *  log ↔ CostEvent for the detail UI. */
  costCategory: z.enum(COST_CATEGORIES).optional(),
  occurredAt: z.string(),
});
export type DataSourceInvocation = z.infer<typeof DataSourceInvocationSchema>;
