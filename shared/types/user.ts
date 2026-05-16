import { PLAN_TIERS, WORKSPACE_ROLES } from '../utils/constants.js';
import type { KnowledgeBaseEntry } from './campaign.js';

export type PlanTier = (typeof PLAN_TIERS)[number];
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export interface WorkspaceMember {
  workspaceId: string;
  role: WorkspaceRole;
}

export interface User {
  _id: string;
  email: string;
  firstName: string;
  // Optional — passwordless + social sign-ups may not capture a last
  // name. Password register still enforces both.
  lastName?: string;
  avatarUrl?: string;
  plan: PlanTier;
  planExpiresAt?: string;
  creditsBalance: number;
  workspaces: WorkspaceMember[];
  isEmailVerified: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettings {
  defaultExportFormat: 'csv' | 'xlsx';
  notifyOnJobComplete: boolean;
  cheapMode: boolean;
  webhookUrl?: string;
}

export interface WorkspaceUsageStats {
  totalJobsRun: number;
  totalLeadsFound: number;
  totalExports: number;
  creditsUsed: number;
}

export interface WorkspaceMemberDetail {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceBranding {
  displayName?: string;
  logoUrl?: string;
  contactEmail?: string;
  reportTitle?: string;
}

export interface Workspace {
  _id: string;
  name: string;
  slug: string;
  ownerId: string;
  /** Multi-client agency mode — when set, this is a client sub-workspace
   *  owned by the parent agency workspace. */
  parentWorkspaceId?: string;
  isClient?: boolean;
  clientLabel?: string;
  branding?: WorkspaceBranding;
  members: WorkspaceMemberDetail[];
  settings: WorkspaceSettings;
  knowledgeBase: KnowledgeBaseEntry[];
  usageStats: WorkspaceUsageStats;
  createdAt: string;
  updatedAt: string;
}
