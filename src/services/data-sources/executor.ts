import mongoose from 'mongoose';
import type { ZodError } from 'zod';
import { getDataSource } from './registry.js';
import { resolveDefaultCredential, resolveCredentialById, markCredentialUsed, markCredentialError } from './credentials.js';
import { reserveRateLimit } from './rateLimit.js';
import DataSourceInvocation, { type IDataSourceInvocationDoc } from '../../models/DataSourceInvocation.js';
import type { InvocationStatus, InvocationTrigger, CostCategory } from '../../../shared/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Executor — the ONE entry point for calling any data source. Handles:
 *   1. Registry lookup
 *   2. Input validation (Zod)
 *   3. Credential resolution (default-by-source or explicit id)
 *   4. Rate limit check (Redis counters)
 *   5. Invocation log row creation (pending → final status)
 *   6. Handler call with typed input + decrypted creds + context
 *   7. Output validation (Zod)
 *   8. Cost recording (CostEvent — Phase 13)
 *   9. Error classification
 *
 * Callers never invoke a DataSource's handler directly. The executor is
 * the only path — means every call is logged, priced, rate-limited, and
 * attributable.
 */

export interface ExecutorContext {
  workspaceId: string;
  triggeredBy: InvocationTrigger;
  jobId?: string;
  leadId?: string;
  tableRowId?: string;
  columnKey?: string;
  /** When provided, uses this specific credential; otherwise falls back
   *  to the workspace's default for the source. */
  credentialId?: string;
}

export interface ExecutorResult<O = unknown> {
  status: InvocationStatus;
  output?: O;
  errorMessage?: string;
  invocationId: string;
  latencyMs: number;
  costUSD?: number;
}

export async function runDataSource<O = unknown>(
  dataSourceId: string,
  rawInput: unknown,
  ctx: ExecutorContext,
): Promise<ExecutorResult<O>> {
  const startedAt = Date.now();
  const ds = getDataSource(dataSourceId);
  if (!ds) {
    // Synthetic invocation — we still log it so "call with unknown id"
    // shows up in the log for debugging.
    const inv = await writeInvocation({
      workspaceId: ctx.workspaceId,
      dataSourceId,
      triggeredBy: ctx.triggeredBy,
      input: rawInput as Record<string, unknown>,
      status: 'failed',
      errorMessage: `Unknown data source: ${dataSourceId}`,
      occurredAt: new Date(),
      parentJobId: ctx.jobId,
      parentLeadId: ctx.leadId,
      parentTableRowId: ctx.tableRowId,
      parentColumnKey: ctx.columnKey,
    });
    return {
      status: 'failed',
      errorMessage: `Unknown data source: ${dataSourceId}`,
      invocationId: String(inv._id),
      latencyMs: Date.now() - startedAt,
    };
  }

  // 1. Input validation
  const parsed = ds.input.schema.safeParse(rawInput);
  if (!parsed.success) {
    const msg = formatZodError(parsed.error);
    const inv = await writeInvocation({
      workspaceId: ctx.workspaceId,
      dataSourceId,
      triggeredBy: ctx.triggeredBy,
      input: rawInput as Record<string, unknown>,
      status: 'invalid_input',
      errorMessage: msg,
      occurredAt: new Date(),
      parentJobId: ctx.jobId,
      parentLeadId: ctx.leadId,
      parentTableRowId: ctx.tableRowId,
      parentColumnKey: ctx.columnKey,
    });
    return {
      status: 'invalid_input',
      errorMessage: msg,
      invocationId: String(inv._id),
      latencyMs: Date.now() - startedAt,
    };
  }
  const input = parsed.data;

  // 2. Rate limit
  const rl = await reserveRateLimit(ds, ctx.workspaceId);
  if (!rl.allowed) {
    const msg = `Rate limit exceeded (${rl.used}/${rl.limit} per ${rl.window})`;
    const inv = await writeInvocation({
      workspaceId: ctx.workspaceId,
      dataSourceId,
      triggeredBy: ctx.triggeredBy,
      input: input as Record<string, unknown>,
      status: 'rate_limited',
      errorMessage: msg,
      occurredAt: new Date(),
      parentJobId: ctx.jobId,
      parentLeadId: ctx.leadId,
      parentTableRowId: ctx.tableRowId,
      parentColumnKey: ctx.columnKey,
    });
    return {
      status: 'rate_limited',
      errorMessage: msg,
      invocationId: String(inv._id),
      latencyMs: Date.now() - startedAt,
    };
  }

  // 3. Credential resolution — only for sources that need one.
  let decrypted: { credentialId: string; fields: Record<string, string> } | null = null;
  if (ds.auth.type !== 'none' && ds.auth.type !== 'platform') {
    const cred = ctx.credentialId
      ? await resolveCredentialById(ctx.workspaceId, ctx.credentialId)
      : await resolveDefaultCredential(ctx.workspaceId, dataSourceId);
    if (!cred) {
      const msg = 'No credential configured for this data source';
      const inv = await writeInvocation({
        workspaceId: ctx.workspaceId,
        dataSourceId,
        triggeredBy: ctx.triggeredBy,
        input: input as Record<string, unknown>,
        status: 'auth_failed',
        errorMessage: msg,
        occurredAt: new Date(),
        parentJobId: ctx.jobId,
        parentLeadId: ctx.leadId,
        parentTableRowId: ctx.tableRowId,
        parentColumnKey: ctx.columnKey,
      });
      return {
        status: 'auth_failed',
        errorMessage: msg,
        invocationId: String(inv._id),
        latencyMs: Date.now() - startedAt,
      };
    }
    decrypted = { credentialId: cred.credentialId, fields: cred.fields };
  }

  // 4. Create pending invocation FIRST — so handler can attach things
  //    to it (future: streamed progress, file-backed output pointers).
  const pending = await writeInvocation({
    workspaceId: ctx.workspaceId,
    dataSourceId,
    triggeredBy: ctx.triggeredBy,
    input: input as Record<string, unknown>,
    status: 'pending',
    occurredAt: new Date(),
    credentialId: decrypted?.credentialId,
    parentJobId: ctx.jobId,
    parentLeadId: ctx.leadId,
    parentTableRowId: ctx.tableRowId,
    parentColumnKey: ctx.columnKey,
  });

  // 5. Invoke handler
  try {
    const rawOutput = await ds.handler(
      input,
      decrypted ? decrypted.fields : null,
      {
        workspaceId: ctx.workspaceId,
        ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
        ...(ctx.leadId ? { leadId: ctx.leadId } : {}),
        ...(ctx.tableRowId ? { tableRowId: ctx.tableRowId } : {}),
        ...(ctx.columnKey ? { columnKey: ctx.columnKey } : {}),
        triggeredBy: ctx.triggeredBy,
        invocationId: String(pending._id),
      },
    );

    // 6. Output validation — catch provider contract drift early.
    const outParsed = ds.output.schema.safeParse(rawOutput);
    const output = outParsed.success ? (outParsed.data as O) : (rawOutput as O);
    if (!outParsed.success) {
      logger.warn('[dataSources] output schema drift', {
        dataSourceId,
        issues: outParsed.error.issues.slice(0, 3),
      });
      // Don't fail — log and surface the raw output. Provider drift is
      // common and schema validation can be tightened later.
    }

    const latencyMs = Date.now() - startedAt;
    const costUSD = ds.pricing.providerCostUSDPerCall;
    const costCategory: CostCategory | undefined = categoryForCost(ds.category);

    await DataSourceInvocation.updateOne(
      { _id: pending._id },
      {
        $set: {
          status: 'success',
          output: truncateForStore(output),
          latencyMs,
          costUSD,
          costCategory,
        },
      },
    );

    if (decrypted) void markCredentialUsed(decrypted.credentialId);

    return {
      status: 'success',
      output,
      invocationId: String(pending._id),
      latencyMs,
      ...(costUSD !== undefined ? { costUSD } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - startedAt;
    const classified = classifyError(msg);

    await DataSourceInvocation.updateOne(
      { _id: pending._id },
      {
        $set: {
          status: classified,
          errorMessage: msg.slice(0, 1000),
          latencyMs,
        },
      },
    );

    if (decrypted && (classified === 'auth_failed' || classified === 'failed')) {
      void markCredentialError(decrypted.credentialId, msg);
    }

    return {
      status: classified,
      errorMessage: msg,
      invocationId: String(pending._id),
      latencyMs,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatZodError(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function classifyError(message: string): InvocationStatus {
  const m = message.toLowerCase();
  if (m.includes('401') || m.includes('403') || m.includes('invalid api key') || m.includes('unauthorized')) {
    return 'auth_failed';
  }
  if (m.includes('429') || m.includes('rate limit') || m.includes('quota')) {
    return 'rate_limited';
  }
  return 'failed';
}

/** Map a data source's category to the cost category it rolls up under. */
function categoryForCost(cat: string): CostCategory | undefined {
  switch (cat) {
    case 'search': return 'serp';
    case 'scrape': return 'scrape';
    case 'audio': return 'transcription';
    case 'fetch': return 'file_fetch';
    case 'library': return undefined; // free — no cost event
    case 'scoring':
    case 'writer':
    case 'enrichment_builtin': return undefined;
    case 'ai': return 'llm';
    default: return undefined; // 15B external sources get explicit cost categories
  }
}

/**
 * Cap output size stored on the invocation to keep doc size under 16MB
 * and listing queries fast. Handlers can still return larger objects to
 * the caller; we just don't persist more than this.
 */
function truncateForStore(output: unknown): Record<string, unknown> {
  try {
    const json = JSON.stringify(output);
    if (json.length <= 60_000) return output as Record<string, unknown>;
    return {
      __truncated: true,
      __originalBytes: json.length,
      preview: json.slice(0, 60_000),
    };
  } catch {
    return { __unserializable: true };
  }
}

interface WriteInvocationInput {
  workspaceId: string;
  dataSourceId: string;
  triggeredBy: InvocationTrigger;
  input: Record<string, unknown>;
  status: InvocationStatus;
  errorMessage?: string;
  occurredAt: Date;
  credentialId?: string;
  parentJobId?: string;
  parentLeadId?: string;
  parentTableRowId?: string;
  parentColumnKey?: string;
}

async function writeInvocation(data: WriteInvocationInput): Promise<IDataSourceInvocationDoc> {
  return await DataSourceInvocation.create({
    workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
    dataSourceId: data.dataSourceId,
    triggeredBy: data.triggeredBy,
    input: truncateForStore(data.input),
    status: data.status,
    errorMessage: data.errorMessage,
    occurredAt: data.occurredAt,
    ...(data.credentialId ? { credentialId: new mongoose.Types.ObjectId(data.credentialId) } : {}),
    ...(data.parentJobId ? { parentJobId: new mongoose.Types.ObjectId(data.parentJobId) } : {}),
    ...(data.parentLeadId ? { parentLeadId: new mongoose.Types.ObjectId(data.parentLeadId) } : {}),
    ...(data.parentTableRowId ? { parentTableRowId: new mongoose.Types.ObjectId(data.parentTableRowId) } : {}),
    ...(data.parentColumnKey ? { parentColumnKey: data.parentColumnKey } : {}),
  });
}
