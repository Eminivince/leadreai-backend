import type { PlanTier } from './user.js';

export interface PlanConfig {
  id: PlanTier;
  label: string;
  tagline: string;
  monthlyCredits: number;
  // USD/month. 0 = free. `null` = contact sales (enterprise).
  priceUsd: number | null;
}

/**
 * The subscription catalogue. Source of truth for plan labels, prices,
 * and the monthly credit allowance granted on renewal. Both the frontend
 * (pricing page, billing, change-plan modal) and the backend (subscribe
 * endpoint, renewal service) consume this — so changing a tier's monthly
 * allowance is a one-line diff.
 *
 * Enterprise is a placeholder price. The renewal service grants its
 * `monthlyCredits` on renewal regardless; real enterprise deals set
 * custom allowances out-of-band.
 */
export const PLAN_CONFIG: PlanConfig[] = [
  {
    id: 'free',
    label: 'Reader',
    tagline: 'For operators running a list a week.',
    monthlyCredits: 5,
    priceUsd: 0,
  },
  {
    id: 'growth',
    label: 'Correspondent',
    tagline: 'For teams prospecting every day.',
    monthlyCredits: 200,
    priceUsd: 49,
  },
  {
    id: 'enterprise',
    label: 'Bureau',
    tagline: 'For teams with a research budget.',
    monthlyCredits: 2000,
    priceUsd: null,
  },
];

export function planConfig(plan: PlanTier): PlanConfig {
  return PLAN_CONFIG.find((p) => p.id === plan) ?? PLAN_CONFIG[0]!;
}
