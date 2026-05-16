import { z } from 'zod';
import { OUTREACH_STATUSES } from '../../utils/constants.js';

export const LeadFilterSchema = z.object({
  jobId: z.string().optional(),
  country: z.string().optional(),
  industry: z.string().optional(),
  hasEmail: z.coerce.boolean().optional(),
  hasPhone: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['rankScore', 'createdAt', 'companyName']).default('rankScore'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const UpdateLeadSchema = z.object({
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string()).optional(),
  outreachStatus: z
    .enum(OUTREACH_STATUSES)
    .optional(),
});

export type LeadFilterInput = z.infer<typeof LeadFilterSchema>;
export type UpdateLeadInput = z.infer<typeof UpdateLeadSchema>;
