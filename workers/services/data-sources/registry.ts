import type { WorkerDataSource } from './types.js';

/**
 * Worker-side data source registry. Populated by each source file calling
 * `registerWorkerDataSource(...)` at module top level. Imported from a
 * barrel (`./sources/index.ts`) before the first executor call.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY = new Map<string, WorkerDataSource<any, any>>();

export function registerWorkerDataSource<I, O>(ds: WorkerDataSource<I, O>): void {
  if (REGISTRY.has(ds.id)) {
    throw new Error(`[workers/data-sources] duplicate id: ${ds.id}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  REGISTRY.set(ds.id, ds as WorkerDataSource<any, any>);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getWorkerDataSource(id: string): WorkerDataSource<any, any> | undefined {
  return REGISTRY.get(id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listWorkerDataSources(): WorkerDataSource<any, any>[] {
  return [...REGISTRY.values()];
}
