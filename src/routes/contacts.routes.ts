import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  listContacts,
  getContact,
  updateContact,
  softDeleteContact,
  bulkTagContacts,
  addManualContact,
  triggerContactEnrichment,
} from '../controllers/contacts.controller.js';

// Mounted at /api/v1/workspaces/:workspaceId/contacts
export const contactsRouter: RouterType = Router({ mergeParams: true });
contactsRouter.use(authenticate);

// IDOR fix: every contact route enforces workspace membership. Read = any
// member; write = owner/admin. Previously list/get/patch were authed-only.
contactsRouter.get('/', authorize(['owner', 'admin', 'member']), asyncHandler(listContacts));
contactsRouter.post('/bulk-tag', authorize(['owner', 'admin']), asyncHandler(bulkTagContacts));
contactsRouter.get('/:contactId', authorize(['owner', 'admin', 'member']), asyncHandler(getContact));
contactsRouter.patch('/:contactId', authorize(['owner', 'admin']), asyncHandler(updateContact));
contactsRouter.delete('/:contactId', authorize(['owner', 'admin']), asyncHandler(softDeleteContact));

// Mounted at /api/v1/workspaces/:workspaceId/leads
export const leadContactsRouter: RouterType = Router({ mergeParams: true });
leadContactsRouter.use(authenticate);

leadContactsRouter.post('/:leadId/contacts', authorize(['owner', 'admin']), asyncHandler(addManualContact));
leadContactsRouter.post('/:leadId/enrich-contacts', authorize(['owner', 'admin']), asyncHandler(triggerContactEnrichment));
