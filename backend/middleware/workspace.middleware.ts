import { Response, NextFunction } from 'express';
import { WorkspaceRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest } from './auth.middleware';

export interface WorkspaceScopedRequest extends AuthenticatedRequest {
  workspaceMembership?: { id: string; role: WorkspaceRole };
}

/**
 * The tenant-isolation gate for any route addressed by a workspaceId —
 * checks `req.params.workspaceId` first (path-based routes, e.g.
 * GET /api/workspaces/:workspaceId/channels), falling back to
 * `req.body.workspaceId` (body-based routes, e.g. POST /api/channels).
 *
 * The Default Workspace (`isDefault: true`) is granted immediately, with no
 * WorkspaceMember lookup at all — it's meant to be reachable by every
 * authenticated user (Rule 2), including one that has never been explicitly
 * added as a member there. Every other (private) workspace falls through to
 * the real membership check: `req.user.id` must have a WorkspaceMember row,
 * same as before. Either way, a handler behind this middleware can trust the
 * caller is allowed into the workspace without re-deriving that itself.
 * `req.workspaceMembership` is only ever populated in the private-workspace
 * branch — nothing downstream currently reads it, but a real membership row
 * simply doesn't exist to attach in the Default Workspace case.
 */
export const requireWorkspaceAccess = async (req: WorkspaceScopedRequest, res: Response, next: NextFunction) => {
  const workspaceId = req.params.workspaceId || req.body?.workspaceId;
  if (!workspaceId || typeof workspaceId !== 'string') {
    return res.status(400).json({ error: 'workspaceId is required' });
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { isDefault: true },
  });
  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  if (workspace.isDefault) {
    return next();
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId } },
    select: { id: true, role: true },
  });

  if (!membership) {
    return res.status(403).json({ error: 'You are not a member of this workspace.' });
  }

  req.workspaceMembership = membership;
  next();
};
