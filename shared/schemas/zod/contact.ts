import { z } from 'zod';

export const contactEmailSchema = z.object({
  address: z.string().email(),
  type: z.enum(['direct', 'pattern_inferred', 'generic']),
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
  source: z.string(),
});

export const contactPhoneSchema = z.object({
  normalized: z.string(),
  type: z.enum(['mobile', 'direct', 'office']),
  source: z.string(),
});

export const updateContactSchema = z.object({
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string()).optional(),
  buyingRole: z.enum(['champion', 'economic_buyer', 'technical_buyer', 'blocker', 'influencer', 'unknown']).optional(),
});

export const bulkTagContactsSchema = z.object({
  contactIds: z.array(z.string()).min(1).max(200),
  tags: z.array(z.string().min(1).max(50)).min(1),
});

export const manualContactSchema = z.object({
  fullName: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  department: z.enum(['sales', 'marketing', 'engineering', 'finance', 'hr', 'legal', 'operations', 'other']).optional(),
  seniority: z.enum(['c_level', 'vp', 'director', 'manager', 'ic', 'unknown']).optional(),
  linkedinUrl: z.string().url().optional().or(z.literal('')).transform(v => v === '' ? undefined : v),
  emails: z.array(contactEmailSchema).optional(),
  phones: z.array(contactPhoneSchema).optional(),
  buyingRole: z.enum(['champion', 'economic_buyer', 'technical_buyer', 'blocker', 'influencer', 'unknown']).optional(),
});
