import type { Request } from 'express';
import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import Workspace from '../models/Workspace.js';
import { logger } from '../utils/logger.js';

type ResourceType =
  | 'job'
  | 'lead'
  | 'campaign'
  | 'outreach_draft'
  | 'contact'
  | 'workspace'
  | 'sequence'
  | 'file'
  | 'document';

interface AuditOptions {
  req: Request;
  workspaceId: string;
  action: string;
  resourceType: ResourceType;
  resourceId: string | mongoose.Types.ObjectId;
  metadata?: Record<string, unknown>;
  durationMs?: number;
}

/** Default audit-log retention if a workspace doesn't override it
 *  (Task #21). Matches the pre-Task-21 global TTL so behaviour stays
 *  identical for the vast majority of workspaces. */
const DEFAULT_RETENTION_DAYS = 90;

// In-memory retention cache. Each workspace's `auditRetentionDays`
// changes rarely, but `logAudit` is on the hot path of every credit
// move + workflow run + payment webhook. We cache for 5 min to keep
// the audit write to a single insert instead of insert + workspace
// read.
const retentionCache = new Map<string, { days: number | undefined; cachedAt: number }>();
const RETENTION_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveRetentionDays(workspaceId: string): Promise<number | undefined> {
  const cached = retentionCache.get(workspaceId);
  if (cached && Date.now() - cached.cachedAt < RETENTION_CACHE_TTL_MS) {
    return cached.days;
  }
  const ws = await Workspace.findById(workspaceId).select('auditRetentionDays').lean();
  const days = ws?.auditRetentionDays;
  retentionCache.set(workspaceId, { days, cachedAt: Date.now() });
  return days;
}

/**
 * Fire-and-forget audit log writer. Never throws — a write failure must
 * not break the surrounding request. Picks the workspace's retention
 * setting (Task #21) and stamps `expiresAt` accordingly; rows with
 * `expiresAt: undefined` survive forever (regulatory-hold path).
 */
export function logAudit(opts: AuditOptions): void {
  const userId = opts.req.user?._id;
  if (!userId) return; // unauthenticated path — skip

  // Resolve retention asynchronously, then write. Returning void
  // immediately keeps callers fire-and-forget.
  void (async (): Promise<void> => {
    try {
      const days = (await resolveRetentionDays(opts.workspaceId)) ?? DEFAULT_RETENTION_DAYS;
      // days === 0 means "keep forever" — leave expiresAt undefined.
      const expiresAt = days > 0 ? new Date(Date.now() + days * 24 * 3600 * 1000) : undefined;

      await AuditLog.create({
        workspaceId: new mongoose.Types.ObjectId(opts.workspaceId),
        userId,
        action: opts.action,
        resourceType: opts.resourceType,
        resourceId: new mongoose.Types.ObjectId(opts.resourceId.toString()),
        metadata: opts.metadata,
        ipAddress: opts.req.ip,
        userAgent: opts.req.headers['user-agent'],
        durationMs: opts.durationMs,
        expiresAt,
      });
    } catch (err: unknown) {
      logger.warn('[audit] Failed to write audit log', {
        action: opts.action,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
