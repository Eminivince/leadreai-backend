import { z } from 'zod';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'invalid id');

export const CreateFileSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  leadIds: z.array(objectId).default([]),
  color: z.string().max(24).optional(),
});

export const UpdateFileSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  color: z.string().max(24).optional(),
  archived: z.boolean().optional(),
});

export const FileMembershipSchema = z.object({
  leadIds: z.array(objectId).min(1),
});

export type CreateFileInput = z.infer<typeof CreateFileSchema>;
export type UpdateFileInput = z.infer<typeof UpdateFileSchema>;
export type FileMembershipInput = z.infer<typeof FileMembershipSchema>;
