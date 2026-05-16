import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import * as controller from '../controllers/dataTables.controller.js';

/**
 * DataTable routes. Mounted at:
 *   /workspaces/:workspaceId/tables                     — list + create
 *   /workspaces/:workspaceId/tables/:tableId            — read/update/delete
 *   /workspaces/:workspaceId/tables/:tableId/columns    — add/update/delete columns
 *   /workspaces/:workspaceId/tables/:tableId/rows       — add/list rows
 *   /workspaces/:workspaceId/tables/:tableId/rows/bulk  — bulk add
 *   /workspaces/:workspaceId/tables/:tableId/rows/:rowId
 *   /workspaces/:workspaceId/tables/:tableId/seed-from-job  — project leads into rows
 */

const router: RouterType = Router({ mergeParams: true });

router.use(authenticate);
router.use(authorize(['owner', 'admin', 'member']));

router.get('/', asyncHandler(controller.listTables));
router.post('/', asyncHandler(controller.createTable));
router.get('/:tableId', asyncHandler(controller.getTable));
router.patch('/:tableId', asyncHandler(controller.updateTable));
router.delete('/:tableId', asyncHandler(controller.deleteTable));

router.post('/:tableId/columns', asyncHandler(controller.addColumn));
router.patch('/:tableId/columns/:columnKey', asyncHandler(controller.updateColumn));
router.delete('/:tableId/columns/:columnKey', asyncHandler(controller.deleteColumn));

router.get('/:tableId/rows', asyncHandler(controller.listRows));
router.post('/:tableId/rows', asyncHandler(controller.addRow));
router.post('/:tableId/rows/bulk', asyncHandler(controller.addRowsBulk));
router.patch('/:tableId/rows/:rowId', asyncHandler(controller.updateRow));
router.delete('/:tableId/rows/:rowId', asyncHandler(controller.deleteRow));
router.post('/:tableId/rows/bulk-action', asyncHandler(controller.bulkRowAction));

router.post('/:tableId/seed-from-job', asyncHandler(controller.seedFromJob));
router.post('/:tableId/to-file', asyncHandler(controller.projectTableToFile));

// Column enrichment (Phase 15D)
router.post('/:tableId/columns/:columnKey/estimate', asyncHandler(controller.estimateEnrichColumn));
router.post('/:tableId/columns/:columnKey/run', asyncHandler(controller.runEnrichColumn));
router.post('/:tableId/columns/:columnKey/rows/:rowId/enrich', asyncHandler(controller.enrichSingleRow));

// Actions (curated enrichment recipes)
router.get('/:tableId/actions', asyncHandler(controller.listActions));
router.post('/:tableId/actions/:actionId/run', asyncHandler(controller.runActionHandler));

export default router;
