import { z } from 'zod';
import type { DataSourceCategory, InvocationTrigger } from '../../../shared/index.js';

/**
 * Worker-side DataSource runtime type. Mirrors backend/src/services/data-sources/types.ts
 * but trimmed — workers don't need the auth.testFn (the backend handles credential
 * creation / testing endpoints). Workers still need input/output schemas + handler.
 *
 * Why two copies: workers' DataSource handlers import worker-specific deps
 * (Playwright, pipeline internals, BullMQ context) that don't belong in
 * backend. Backend's DataSource handlers import HTTP clients and run in
 * the Express request lifecycle. The schemas (for input/output validation)
 * + invocation model are shared via Mongo collection name ('datasourceinvocations').
 */
export interface WorkerDataSource<I = unknown, O = unknown> {
  id: string;
  name: string;
  description: string;
  category: DataSourceCategory;
  version: number;

  input: {
    schema: z.ZodSchema<I>;
    describe: Array<{ key: string; label: string; required: boolean; hint?: string }>;
  };

  output: {
    schema: z.ZodSchema<O>;
    describe: Array<{ key: string; label: string; type: string }>;
  };

  handler: (input: I, ctx: WorkerDataSourceContext) => Promise<O>;
}

export interface WorkerDataSourceContext {
  workspaceId: string;
  jobId?: string;
  leadId?: string;
  triggeredBy: InvocationTrigger;
  invocationId: string;
}
