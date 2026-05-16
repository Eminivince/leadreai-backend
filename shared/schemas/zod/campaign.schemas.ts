import { z } from 'zod';
import { OUTREACH_CHANNELS } from '../../utils/constants.js';

/**
 * Canonical typed payload for creating a campaign from the wizard.
 *
 * The frontend wizard keeps its own UI-friendly state (strings like "9–5",
 * "Mon–Fri", "Day 3"). Before POSTing, the wizard normalizes everything into
 * the shape below — so the backend schema is typed, the API contract is
 * single-shaped, and any future non-wizard API client can hit the same
 * endpoint without a string parser.
 */

// ── Step -----------------------------------------------------------------
//
// A campaign step is authored in one of two modes:
//   - useAI=false → the email is rendered from `subject` + `body` at send time
//                    (merge tokens like {{first_name}} resolve against the
//                    lead/contact via templateRenderer).
//   - useAI=true  → the worker calls the Claude outreach draft service at send
//                    time, passing `tone` + `goal` + the authored `subject`/`body`
//                    as hints. Each lead gets a bespoke draft. More credits,
//                    higher reply rates — commercial differentiator vs. Outreach/Apollo.
//
// Both modes persist the authored `subject`/`body` so the user can toggle
// without losing work. The worker decides per-step at send time which to use.
export const CampaignStepInputSchema = z.object({
  channel: z.enum(OUTREACH_CHANNELS),
  delayDays: z.number().int().min(0).max(365),
  subject: z.string().max(500).default(''),
  body: z.string().max(10_000).default(''),
  tone: z.string().min(1).max(50).default('direct'),
  goal: z.string().max(200).default(''),
  useAI: z.boolean().default(false),
});
export type CampaignStepInput = z.infer<typeof CampaignStepInputSchema>;

// ── Schedule -------------------------------------------------------------
//
// Single global schedule; every step inherits. `allowedDays` follows JS
// Date.getDay() convention (0=Sun, 6=Sat) — the wizard shows Mon/Tue/…/Sun,
// translates to numeric on save.
export const CampaignScheduleSchema = z
  .object({
    timezone: z.string().min(1), // IANA — validated at runtime against Intl
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
    allowedDays: z.array(z.number().int().min(0).max(6)).min(1),
    dailySendCap: z.number().int().min(1).max(5000),
  })
  .refine((s) => s.endHour > s.startHour, {
    message: 'endHour must be greater than startHour',
    path: ['endHour'],
  });
export type CampaignSchedule = z.infer<typeof CampaignScheduleSchema>;

// ── Audience filters ----------------------------------------------------
//
// Applied at enrollment time (M2). `excludeCRM` intentionally dropped until
// the CRM connector framework lands — shipping a UI checkbox that does
// nothing is worse than not having the feature.
export const CampaignAudienceFiltersSchema = z.object({
  hotOnly: z.boolean().default(false),      // rankScore >= 90
  verifiedOnly: z.boolean().default(false), // skip pattern-inferred emails
});
export type CampaignAudienceFilters = z.infer<typeof CampaignAudienceFiltersSchema>;

// ── Reply rules ---------------------------------------------------------
//
// Data-model only for M1. M2 wires `pauseOnReply` into enrollment state
// transitions; M4 wires `classify` + `notifyChannel` once inbound webhooks land.
export const CampaignReplyRulesSchema = z.object({
  pauseOnReply: z.boolean().default(true),
  classify: z.boolean().default(false),
  notifyChannel: z.enum(['slack', 'email', 'none']).default('none'),
});
export type CampaignReplyRules = z.infer<typeof CampaignReplyRulesSchema>;

// ── Top-level create payload --------------------------------------------
export const CreateCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  fileId: z.string().regex(/^[a-f0-9]{24}$/i, 'invalid fileId'),

  steps: z.array(CampaignStepInputSchema).min(1).max(20),
  schedule: CampaignScheduleSchema,
  audienceFilters: CampaignAudienceFiltersSchema.default({
    hotOnly: false,
    verifiedOnly: false,
  }),
  replyRules: CampaignReplyRulesSchema.default({
    pauseOnReply: true,
    classify: false,
    notifyChannel: 'none',
  }),

  // Language is campaign-wide (vs. per-step) for v1. Tone is per-step.
  language: z.string().min(1).max(50).default('English'),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

// ── Partial update payload (PATCH /campaigns/:id) -----------------------
//
// Kept narrow for M1. Step edits on existing campaigns require sequence
// versioning (not yet scoped) — for now, step changes require deleting
// and recreating the campaign.
export const UpdateCampaignSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  audienceFilters: CampaignAudienceFiltersSchema.optional(),
  replyRules: CampaignReplyRulesSchema.optional(),
  schedule: CampaignScheduleSchema.optional(),
});
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignSchema>;
