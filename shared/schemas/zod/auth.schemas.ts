import { z } from 'zod';
import { PLAN_TIERS } from '../../utils/constants.js';

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Intentional projection of User — omits passwordHash, workspaces, and internal timestamps
export const MeResponseSchema = z.object({
  _id: z.string(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  avatarUrl: z.string().optional(),
  plan: z.enum(PLAN_TIERS),
  creditsBalance: z.number(),
  isEmailVerified: z.boolean(),
  createdAt: z.string(),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
