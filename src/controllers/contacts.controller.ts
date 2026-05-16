import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Contact } from '../models/Contact.js';
import Lead from '../models/Lead.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from '../services/audit.js';
import { updateContactSchema, bulkTagContactsSchema, manualContactSchema, SENIORITY_LEVELS, DEPARTMENTS } from '../../shared/index.js';
import { getContactEnrichmentQueue } from '../services/queue/queues.js';

// GET /contacts
export async function listContacts(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10) || 20));

  const leadId = req.query['leadId'] as string | undefined;
  const seniority = req.query['seniority'] as string | undefined;
  const department = req.query['department'] as string | undefined;
  const hasEmail = req.query['hasEmail'] as string | undefined;
  const sortBy = req.query['sortBy'] as string | undefined;

  const filter: Record<string, unknown> = { workspaceId, isActive: true };

  if (leadId) {
    if (!mongoose.Types.ObjectId.isValid(leadId)) {
      throw ApiError.badRequest('Invalid leadId');
    }
    filter['leadId'] = new mongoose.Types.ObjectId(leadId);
  }

  if (seniority && !(SENIORITY_LEVELS as readonly string[]).includes(seniority)) {
    throw ApiError.badRequest(`seniority must be one of: ${SENIORITY_LEVELS.join(', ')}`);
  }
  if (department && !(DEPARTMENTS as readonly string[]).includes(department)) {
    throw ApiError.badRequest(`department must be one of: ${DEPARTMENTS.join(', ')}`);
  }

  if (seniority) filter['seniority'] = seniority;
  if (department) filter['department'] = department;

  if (hasEmail === 'true') {
    filter['emails.0'] = { $exists: true };
  } else if (hasEmail === 'false') {
    filter['emails.0'] = { $exists: false };
  }

  let sort: [string, 1 | -1][];
  if (sortBy === 'confidence') {
    sort = [['confidenceScore', -1]];
  } else if (sortBy === 'freshness') {
    sort = [['freshnessScore', -1]];
  } else {
    sort = [['createdAt', -1]];
  }

  const [contacts, total] = await Promise.all([
    Contact.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    Contact.countDocuments(filter),
  ]);

  res.json({ success: true, data: { data: contacts, total, page, limit } });
}

// GET /contacts/:contactId
export async function getContact(req: Request, res: Response): Promise<void> {
  const { workspaceId, contactId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(contactId!)) {
    throw ApiError.badRequest('Invalid contactId');
  }

  const contact = await Contact.findOne({ _id: contactId, workspaceId, isActive: true });
  if (!contact) throw ApiError.notFound('Contact not found');

  res.json({ success: true, data: contact });
}

// PATCH /contacts/:contactId
export async function updateContact(req: Request, res: Response): Promise<void> {
  const { workspaceId, contactId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(contactId!)) {
    throw ApiError.badRequest('Invalid contactId');
  }

  const parsed = updateContactSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.errors[0]?.message ?? 'Invalid request body');
  }

  const { notes, tags, buyingRole } = parsed.data;
  const setFields: Record<string, unknown> = {};

  if (notes !== undefined) setFields['notes'] = notes;
  if (tags !== undefined) setFields['tags'] = tags;
  if (buyingRole !== undefined) setFields['buyingRole'] = buyingRole;

  if (Object.keys(setFields).length === 0) {
    throw ApiError.badRequest('No valid fields to update');
  }

  const contact = await Contact.findOneAndUpdate(
    { _id: contactId, workspaceId, isActive: true },
    { $set: setFields },
    { new: true, runValidators: true }
  );

  if (!contact) throw ApiError.notFound('Contact not found');

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'contact.update',
    resourceType: 'contact',
    resourceId: contact._id,
    metadata: { fields: Object.keys(setFields) },
  });

  res.json({ success: true, data: contact });
}

// DELETE /contacts/:contactId → soft-delete
export async function softDeleteContact(req: Request, res: Response): Promise<void> {
  const { workspaceId, contactId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(contactId!)) {
    throw ApiError.badRequest('Invalid contactId');
  }

  const contact = await Contact.findOneAndUpdate(
    { _id: contactId, workspaceId, isActive: true },
    { $set: { isActive: false } },
    { new: true }
  );

  if (!contact) throw ApiError.notFound('Contact not found');

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'contact.delete',
    resourceType: 'contact',
    resourceId: contact._id,
    metadata: { fullName: contact.fullName },
  });

  res.json({ success: true });
}

// POST /contacts/bulk-tag
export async function bulkTagContacts(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;

  const parsed = bulkTagContactsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.errors[0]?.message ?? 'Invalid request body');
  }

  const { contactIds, tags } = parsed.data;

  for (const id of contactIds) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid contactId: ${id}`);
    }
  }

  const objectIds = contactIds.map((id) => new mongoose.Types.ObjectId(id));

  const result = await Contact.updateMany(
    { _id: { $in: objectIds }, workspaceId, isActive: true },
    { $addToSet: { tags: { $each: tags } } }
  );

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'contact.bulk_tag',
    resourceType: 'contact',
    resourceId: workspaceId!,
    metadata: { contactCount: result.modifiedCount, tags },
  });

  res.json({ success: true, data: { modifiedCount: result.modifiedCount } });
}

// POST /leads/:leadId/contacts — manually add contact to a lead
export async function addManualContact(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, leadId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(leadId!)) {
    throw ApiError.badRequest('Invalid leadId');
  }

  const parsed = manualContactSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.errors[0]?.message ?? 'Invalid request body');
  }

  const lead = await Lead.findOne({ _id: leadId, workspaceId });
  if (!lead) throw ApiError.notFound('Lead not found');

  const contact = await Contact.create({
    workspaceId: workspaceId!,
    leadId: new mongoose.Types.ObjectId(leadId),
    ...parsed.data,
    confidenceScore: 50,
    sources: [],
  });

  // Push contactId into lead.contactIds and update contactSummary
  await Lead.updateOne(
    { _id: leadId, workspaceId },
    {
      $addToSet: { contactIds: contact._id },
      $inc: { 'contactSummary.totalContacts': 1 },
    }
  );

  logAudit({
    req,
    workspaceId: workspaceId!,
    action: 'contact.create_manual',
    resourceType: 'contact',
    resourceId: contact._id,
    metadata: { fullName: contact.fullName, leadId },
  });

  res.status(201).json({ success: true, data: contact });
}

// POST /leads/:leadId/enrich-contacts — enqueue contact enrichment job
export async function triggerContactEnrichment(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const { workspaceId, leadId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(leadId!)) {
    throw ApiError.badRequest('Invalid leadId');
  }

  const lead = await Lead.findOne({ _id: leadId, workspaceId });
  if (!lead) throw ApiError.notFound('Lead not found');

  const queue = getContactEnrichmentQueue();
  const job = await queue.add('enrich', {
    workspaceId,
    leadId,
    companyDomain: lead.companyDomain,
    companyName: lead.companyName,
    websiteUrl: lead.website,
    existingEmails: lead.emails.map((e) => e.address),
  });

  res.json({ success: true, data: { jobId: job.id } });
}
