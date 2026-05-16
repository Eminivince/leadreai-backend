import { z } from 'zod';
import { ColumnDefSchema, RowTypeSchema } from './dataTable.schemas.js';

/**
 * Workflow — a saved table template (columns + bindings) + optional agent
 * seed query. Running a workflow produces a fresh DataTable with the
 * template columns and, if the seed is present, dispatches a prospecting
 * job targeted at the new table.
 *
 * Phase 11 M1 (post 2026-04-22 pivot). v1 is always `origin: 'local'` —
 * publish/install lands in M2.
 */

// ── Seed parameter ──────────────────────────────────────────────────

export const WORKFLOW_PARAM_TYPES = ['text', 'number', 'select'] as const;
export const WorkflowParamTypeSchema = z.enum(WORKFLOW_PARAM_TYPES);

export const WorkflowSeedParamSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase snake_case').max(40),
  label: z.string().min(1).max(120),
  type: WorkflowParamTypeSchema,
  defaultValue: z.union([z.string().max(500), z.number()]).optional(),
  options: z.array(z.string().max(120)).optional(),
  required: z.boolean().default(false),
});
export type WorkflowSeedParam = z.infer<typeof WorkflowSeedParamSchema>;

export const WorkflowSeedSchema = z.object({
  rawQueryTemplate: z.string().min(1).max(4000),
  parameters: z.array(WorkflowSeedParamSchema).max(20).default([]),
});
export type WorkflowSeed = z.infer<typeof WorkflowSeedSchema>;

// ── Table template ───────────────────────────────────────────────────

export const WorkflowTableTemplateSchema = z.object({
  rowType: RowTypeSchema,
  columns: z.array(ColumnDefSchema),
  /** Optional template for the new table's name, using the seed's
   *  `{{placeholders}}`. Falls back to `workflow.name` if unset. */
  defaultTableNameTemplate: z.string().max(240).optional(),
});
export type WorkflowTableTemplate = z.infer<typeof WorkflowTableTemplateSchema>;

// ── Workflow doc ─────────────────────────────────────────────────────

/** Phase 11 M1 v1 = `local`. M2 adds `installed` for the share-token flow. */
export const WORKFLOW_ORIGINS = ['local', 'installed'] as const;
export const WorkflowOriginSchema = z.enum(WORKFLOW_ORIGINS);

export const WorkflowStatsSchema = z.object({
  timesRun: z.number().int().nonnegative().default(0),
  lastRunAt: z.string().optional(),
});

/** Counters for the publish surface (Phase 11 M2). Only populated when
 *  the workflow has ever been published. */
export const WorkflowPublishStatsSchema = z.object({
  installs: z.number().int().nonnegative().default(0),
  lastInstalledAt: z.string().optional(),
});

/** Provenance pointer set on installed copies. Stores the share-token
 *  used + the source workflow + the user who published. Lets the
 *  installing workspace show "from <agency>" badges and trace updates
 *  back upstream if/when live-link semantics ever land. */
export const WorkflowInstalledFromSchema = z.object({
  shareToken: z.string(),
  sourceWorkflowId: z.string(),
  sourceWorkspaceId: z.string(),
  publishedBy: z.string(),
  installedAt: z.string(),
});

export const WorkflowSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  createdBy: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).default([]),
  tableTemplate: WorkflowTableTemplateSchema,
  seed: WorkflowSeedSchema.optional(),
  origin: WorkflowOriginSchema,
  stats: WorkflowStatsSchema,
  /** Set by /publish; cleared by /unpublish. URL-safe random 32-char token. */
  shareToken: z.string().optional(),
  publishedAt: z.string().optional(),
  publishStats: WorkflowPublishStatsSchema.optional(),
  /** Only present when origin === 'installed'. */
  installedFrom: WorkflowInstalledFromSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// ── Inputs ──────────────────────────────────────────────────────────

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).optional(),
  tableTemplate: WorkflowTableTemplateSchema,
  seed: WorkflowSeedSchema.optional(),
});
export type CreateWorkflowInput = z.infer<typeof CreateWorkflowSchema>;

/** Snapshot an existing DataTable into a new workflow. The backend looks
 *  up the table, copies its rowType + columns, and if `includeSeed` is
 *  true AND the table has a `sourceJobId`, captures that job's rawQuery
 *  as a parameter-less template. */
export const CreateWorkflowFromTableSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).optional(),
  includeSeed: z.boolean().default(false),
  defaultTableNameTemplate: z.string().max(240).optional(),
});
export type CreateWorkflowFromTableInput = z.infer<typeof CreateWorkflowFromTableSchema>;

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).optional(),
  seed: WorkflowSeedSchema.nullable().optional(),  // null → clear seed
  tableTemplate: WorkflowTableTemplateSchema.optional(),
});
export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowSchema>;

export const RunWorkflowSchema = z.object({
  tableName: z.string().min(1).max(200),
  tableDescription: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).optional(),
  /** Values for the seed's `{{placeholders}}`. Keys must match
   *  `workflow.seed.parameters[].key`. Ignored if the workflow has no seed. */
  seedParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /** If true, dispatches a prospecting job targeted at the new table
   *  after creation. Ignored (as if false) if the workflow has no seed. */
  dispatchSeedJob: z.boolean().default(false),
});
export type RunWorkflowInput = z.infer<typeof RunWorkflowSchema>;

export const RunWorkflowResponseSchema = z.object({
  tableId: z.string(),
  jobId: z.string().optional(),
});
export type RunWorkflowResponse = z.infer<typeof RunWorkflowResponseSchema>;

// ── Publish / install (Phase 11 M2) ──────────────────────────────────

/** Public-facing preview of a published workflow. The actual `Workflow`
 *  shape leaks workspaceId + createdBy, which we redact for unauth'd
 *  preview reads. */
export const WorkflowPublicPreviewSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  tableTemplate: WorkflowTableTemplateSchema,
  hasSeed: z.boolean(),
  seedParameters: z.array(WorkflowSeedParamSchema).optional(),
  publishedAt: z.string(),
  publishStats: WorkflowPublishStatsSchema,
});
export type WorkflowPublicPreview = z.infer<typeof WorkflowPublicPreviewSchema>;

export const InstallWorkflowSchema = z.object({
  /** Target workspace the install should land in. Caller must be a
   *  member; backend enforces. */
  targetWorkspaceId: z.string(),
  /** Optional rename so the user can drop conflicts in their own space
   *  without editing post-install. */
  name: z.string().min(1).max(200).optional(),
});
export type InstallWorkflowInput = z.infer<typeof InstallWorkflowSchema>;
