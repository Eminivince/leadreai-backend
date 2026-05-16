import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Cost context — AsyncLocalStorage-scoped workspace/job/campaign identity
 * that threads through every cost-emitting tool call without adding a
 * parameter to every callsite.
 *
 * Set once at the worker's job boundary (prospecting worker, outreach
 * worker, sequence worker) via `runWithCostContext`. Read implicitly by
 * the cost tracker helpers. If no context is active — e.g. a dev-time
 * script — the tracker silently drops the event.
 *
 * Why AsyncLocalStorage: threading {workspaceId, jobId} through every
 * tool call would touch 40+ signatures. This gets the same information
 * to the tracker without ceremony, and it's exactly what Node's own
 * tracing utilities use.
 */

export interface CostContext {
  workspaceId: string;
  jobId?: string;
  campaignId?: string;
}

const storage = new AsyncLocalStorage<CostContext>();

export function runWithCostContext<T>(ctx: CostContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Returns null if no context is active — callers (trackers) treat that as "skip write." */
export function getCostContext(): CostContext | null {
  return storage.getStore() ?? null;
}
