/**
 * Barrel — importing this file populates the backend-side DataSource
 * registry via the per-source modules' top-level `registerDataSource`
 * calls.
 *
 * Backend hosts the credentialed / external sources. Each module
 * registers itself at import time; the Express bootstrap imports this
 * barrel once (see backend/src/index.ts) so all sources are discoverable
 * before any request handler queries the registry.
 */

import './apollo-people-match.js';
import './apollo-org-enrich.js';
import './hunter-email-finder.js';
import './zerobounce-verify.js';
