import type { DataSource } from './types.js';
import type { DataSourceSummary, DataSourceCategory } from '../../../shared/index.js';

/**
 * In-memory registry. Data sources are added to the registry at import
 * time (each source file calls `registerDataSource(...)` at module top
 * level, and the registry is imported from a barrel `./sources/index.ts`).
 *
 * Startup ordering: as long as the barrel is imported before the first
 * `runDataSource` call, the map is populated. We don't expect dynamic
 * registration at runtime — but nothing prevents it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY = new Map<string, DataSource<any, any>>();

export function registerDataSource<I, O>(ds: DataSource<I, O>): void {
  if (REGISTRY.has(ds.id)) {
    throw new Error(`[data-sources] duplicate id: ${ds.id}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  REGISTRY.set(ds.id, ds as DataSource<any, any>);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getDataSource(id: string): DataSource<any, any> | undefined {
  return REGISTRY.get(id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listDataSources(): DataSource<any, any>[] {
  return [...REGISTRY.values()];
}

export function listByCategory(category: DataSourceCategory): DataSource[] {
  return listDataSources().filter((d) => d.category === category);
}

/** Serializable summary — what the REST endpoint `GET /data-sources` returns. */
export function toSummary(ds: DataSource): DataSourceSummary {
  return {
    id: ds.id,
    name: ds.name,
    description: ds.description,
    category: ds.category,
    version: ds.version,
    auth: {
      type: ds.auth.type,
      fields: ds.auth.fields,
    },
    pricing: ds.pricing,
    rateLimit: ds.rateLimit,
    inputFields: ds.input.describe,
    outputFields: ds.output.describe,
  };
}

export function summarize(): DataSourceSummary[] {
  return listDataSources().map(toSummary);
}
