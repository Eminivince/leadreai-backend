import type { Request, Response, NextFunction } from 'express';
import Workspace from '../models/Workspace.js';
import { ApiError } from '../utils/ApiError.js';

type WorkspaceRole = 'owner' | 'admin' | 'member';

/**
 * Resolve the caller's effective role in a workspace, accounting for
 * multi-client agency mode: if the workspace has a parent and the user
 * is owner/admin of the parent, they inherit owner-level access here.
 *
 * Returns undefined when the user has no relationship to the workspace.
 */
async function resolveEffectiveRole(
  workspace: InstanceType<typeof Workspace>,
  userId: string,
): Promise<WorkspaceRole | undefined> {
  if (workspace.ownerId.toString() === userId) return 'owner';
  const direct = workspace.members.find((m) => m.userId.toString() === userId);
  if (direct?.role) return direct.role as WorkspaceRole;

  // Agency-mode inheritance — parent owners/admins get owner access in
  // child client workspaces. Member-level parents don't get cross-over;
  // that's deliberate so an agency analyst doesn't accidentally see
  // every client's data.
  if (!workspace.parentWorkspaceId) return undefined;
  const parent = await Workspace.findById(workspace.parentWorkspaceId)
    .select('ownerId members')
    .lean();
  if (!parent) return undefined;
  if (parent.ownerId.toString() === userId) return 'owner';
  const parentMember = parent.members?.find(
    (m: { userId: { toString(): string }; role?: string }) => m.userId.toString() === userId,
  );
  if (parentMember?.role === 'owner' || parentMember?.role === 'admin') return 'owner';
  return undefined;
}

export function authorize(requiredRoles: WorkspaceRole[] = ['owner', 'admin', 'member']) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.params;
      if (!workspaceId) {
        throw ApiError.badRequest('workspaceId param required');
      }
      if (!req.user) {
        throw ApiError.unauthorized();
      }

      const workspace = await Workspace.findById(workspaceId);
      if (!workspace) {
        throw ApiError.notFound('Workspace not found');
      }

      const userRole = await resolveEffectiveRole(workspace, req.user._id.toString());
      if (!userRole || !requiredRoles.includes(userRole)) {
        throw ApiError.forbidden('Insufficient workspace permissions');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
