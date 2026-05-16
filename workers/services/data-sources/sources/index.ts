/**
 * Barrel — importing this file populates the worker-side DataSource
 * registry via the per-source modules' top-level `registerWorkerDataSource`
 * calls.
 *
 * Register order doesn't matter functionally but is kept readable: cost
 * tier (cheap → expensive), matching the tool registry's intent.
 */

// Library tier — cheapest, try first. Reuses workspace's prior research.
import './search-workspace-leads.js';
// Search tier — multi-provider SERP router with cache + failover.
import './search-web.js';
