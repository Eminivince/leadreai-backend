import { z } from 'zod';
import type {
  DataSourceCategory,
  DataSourceAuthType,
  InvocationTrigger,
} from '../../../shared/index.js';

/**
 * Runtime DataSource definition. Lives in backend code (the handler is a
 * function — not serializable). A serializable `DataSourceSummary` view
 * is in shared/ for UI listing.
 *
 * Registered in `registry.ts`. Called only via `executor.ts::runDataSource`
 * which handles auth, rate limits, invocation logging, and cost recording.
 */

export interface DataSource<I = unknown, O = unknown> {
  id: string;
  name: string;
  description: string;
  category: DataSourceCategory;
  version: number;

  auth: {
    type: DataSourceAuthType;
    /** Required when type != 'none' and != 'platform'. */
    fields?: Array<{ key: string; label: string; secret: boolean; hint?: string }>;
    /** Optional live credential test. Returns ok:true on a successful probe.
     *  The DS's own /validate or /health endpoint when available, otherwise
     *  a zero-cost call to the cheapest real endpoint. */
    testFn?: (creds: Record<string, string>) => Promise<{ ok: boolean; message?: string }>;
  };

  input: {
    schema: z.ZodSchema<I>;
    describe: Array<{ key: string; label: string; required: boolean; hint?: string }>;
  };

  output: {
    schema: z.ZodSchema<O>;
    /** Human-readable description of output fields for the UI (Tables column
     *  picker, invocation detail page). */
    describe: Array<{ key: string; label: string; type: string }>;
  };

  pricing: {
    model: 'byok' | 'metered' | 'free';
    creditsPerCall?: number;
    providerCostUSDPerCall?: number;
    notes?: string;
  };

  rateLimit?: {
    perMinute?: number;
    perDay?: number;
  };

  /** The actual work. Receives validated input, decrypted creds (or null for
   *  no-auth / platform sources), and a typed context for the invocation
   *  (workspace, job, row, etc.). Throws on upstream failure; the executor
   *  classifies and records. */
  handler: (
    input: I,
    creds: Record<string, string> | null,
    ctx: DataSourceContext,
  ) => Promise<O>;
}

export interface DataSourceContext {
  workspaceId: string;
  jobId?: string;
  leadId?: string;
  tableRowId?: string;
  columnKey?: string;
  triggeredBy: InvocationTrigger;
  /** Invocation id, set by the executor BEFORE calling handler so the
   *  handler can attribute downstream CostEvents or emit progress with it. */
  invocationId: string;
}
