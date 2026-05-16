import mongoose, { Schema } from 'mongoose';
import type { ZodError } from 'zod';
import {
  INVOCATION_STATUSES,
  INVOCATION_TRIGGERS,
  COST_CATEGORIES,
  type InvocationStatus,
  type InvocationTrigger,
  type CostCategory,
} from '../../../shared/index.js';
import { getWorkerDataSource } from './registry.js';
import { logger } from '../../utils/logger.js';

/**
 * Worker-side executor — single entry point for calling any worker-registered
 * DataSource. Parallels backend/src/services/data-sources/executor.ts but
 * for handlers that need worker deps (Playwright, BullMQ, pipeline internals).
 *
 * Both executors write to the SAME Mongo collection (datasourceinvocations)
 * so the invocation log is unified regardless of which side served the call.
 *
 * What this executor does NOT do (worker-side):
 *   - Credential resolution — workers don't own the credential model; all
 *     credentialed sources live backend-side. This executor handles only
 *     no-auth / platform sources.
 *   - Rate limiting — the worker registry's sources are internal; limits
 *     are enforced where they matter (SERP router has its own, Playwright
 *     concurrency is env-gated).
 */

// ── Inline invocation model (workers pattern, strict:false) ──
const invocationSchema = new Schema(
  {
    workspaceId: Schema.Types.ObjectId,
    dataSourceId: String,
    credentialId: Schema.Types.ObjectId,
    triggeredBy: { type: String, enum: INVOCATION_TRIGGERS },
    parentJobId: Schema.Types.ObjectId,
    parentLeadId: Schema.Types.ObjectId,
    parentTableRowId: Schema.Types.ObjectId,
    parentColumnKey: String,
    input: Schema.Types.Mixed,
    output: Schema.Types.Mixed,
    status: { type: String, enum: INVOCATION_STATUSES },
    errorMessage: String,
    latencyMs: Number,
    costUSD: Number,
    costCategory: { type: String, enum: COST_CATEGORIES },
    occurredAt: Date,
  },
  { strict: false },
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const InvocationModel: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['DataSourceInvocation'] as mongoose.Model<any> | undefined) ??
  mongoose.model('DataSourceInvocation', invocationSchema, 'datasourceinvocations');

// ── Executor API ──────────────────────────────────────────────────────

export interface WorkerExecutorContext {
  workspaceId: string;
  triggeredBy: InvocationTrigger;
  jobId?: string;
  leadId?: string;
}

export interface WorkerExecutorResult<O = unknown> {
  status: InvocationStatus;
  output?: O;
  errorMessage?: string;
  invocationId: string;
  latencyMs: number;
}

export async function runWorkerDataSource<O = unknown>(
  dataSourceId: string,
  rawInput: unknown,
  ctx: WorkerExecutorContext,
): Promise<WorkerExecutorResult<O>> {
  const startedAt = Date.now();
  const ds = getWorkerDataSource(dataSourceId);
  if (!ds) {
    const inv = await writeInvocation({
      workspaceId: ctx.workspaceId,
      dataSourceId,
      triggeredBy: ctx.triggeredBy,
      input: rawInput as Record<string, unknown>,
      status: 'failed',
      errorMessage: `Unknown data source: ${dataSourceId}`,
      parentJobId: ctx.jobId,
      parentLeadId: ctx.leadId,
      latencyMs: 0,
    });
    return {
      status: 'failed',
      errorMessage: `Unknown data source: ${dataSourceId}`,
      invocationId: String(inv._id),
      latencyMs: Date.now() - startedAt,
    };
  }

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
      parentJobId: ctx.jobId,
      parentLeadId: ctx.leadId,
      latencyMs: 0,
    });
    return {
      status: 'invalid_input',
      errorMessage: msg,
      invocationId: String(inv._id),
      latencyMs: Date.now() - startedAt,
    };
  }

  const pending = await writeInvocation({
    workspaceId: ctx.workspaceId,
    dataSourceId,
    triggeredBy: ctx.triggeredBy,
    input: parsed.data as Record<string, unknown>,
    status: 'pending',
    parentJobId: ctx.jobId,
    parentLeadId: ctx.leadId,
    latencyMs: 0,
  });

  try {
    const rawOutput = await ds.handler(parsed.data, {
      workspaceId: ctx.workspaceId,
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
      ...(ctx.leadId ? { leadId: ctx.leadId } : {}),
      triggeredBy: ctx.triggeredBy,
      invocationId: String(pending._id),
    });

    const outParsed = ds.output.schema.safeParse(rawOutput);
    const output = outParsed.success ? (outParsed.data as O) : (rawOutput as O);
    if (!outParsed.success) {
      logger.warn('[workers/data-sources] output schema drift', {
        dataSourceId,
        issues: outParsed.error.issues.slice(0, 3),
      });
    }

    const latencyMs = Date.now() - startedAt;
    const costCategory = categoryForCost(ds.category);

    await InvocationModel.updateOne(
      { _id: pending._id },
      {
        $set: {
          status: 'success',
          output: truncateForStore(output),
          latencyMs,
          ...(costCategory ? { costCategory } : {}),
        },
      },
    );

    return {
      status: 'success',
      output,
      invocationId: String(pending._id),
      latencyMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - startedAt;
    const classified = classifyError(msg);
    await InvocationModel.updateOne(
      { _id: pending._id },
      {
        $set: { status: classified, errorMessage: msg.slice(0, 1000), latencyMs },
      },
    );
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

function categoryForCost(cat: string): CostCategory | undefined {
  switch (cat) {
    case 'search': return 'serp';
    case 'scrape': return 'scrape';
    case 'audio': return 'transcription';
    case 'fetch': return 'file_fetch';
    default: return undefined;
  }
}

function truncateForStore(output: unknown): Record<string, unknown> {
  try {
    const json = JSON.stringify(output);
    if (json.length <= 60_000) return output as Record<string, unknown>;
    return { __truncated: true, __originalBytes: json.length, preview: json.slice(0, 60_000) };
  } catch {
    return { __unserializable: true };
  }
}

interface WriteInput {
  workspaceId: string;
  dataSourceId: string;
  triggeredBy: InvocationTrigger;
  input: Record<string, unknown>;
  status: InvocationStatus;
  errorMessage?: string;
  parentJobId?: string;
  parentLeadId?: string;
  latencyMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeInvocation(data: WriteInput): Promise<any> {
  return await InvocationModel.create({
    workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
    dataSourceId: data.dataSourceId,
    triggeredBy: data.triggeredBy,
    input: truncateForStore(data.input),
    status: data.status,
    errorMessage: data.errorMessage,
    occurredAt: new Date(),
    latencyMs: data.latencyMs,
    ...(data.parentJobId ? { parentJobId: new mongoose.Types.ObjectId(data.parentJobId) } : {}),
    ...(data.parentLeadId ? { parentLeadId: new mongoose.Types.ObjectId(data.parentLeadId) } : {}),
  });
}
