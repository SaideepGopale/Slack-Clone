import { Response, NextFunction } from 'express';
import { HttpError } from '../lib/httpError';
import { canWorkspace, loadWorkspaceActor, WorkspaceActor } from '../lib/policy';
import { AuthenticatedRequest } from './auth.middleware';

export interface WorkspaceScopedRequest extends AuthenticatedRequest {
  // Batch 3/E: the caller's resolved roles (lib/policy), for handlers that
  // need more than "may enter".
  workspaceActor?: WorkspaceActor;
}

/**
 * The tenant-isolation gate for any route addressed by a workspaceId —
 * checks `req.params.workspaceId` first (path-based routes, e.g.
 * GET /api/workspaces/:workspaceId/channels), falling back to
 * `req.body.workspaceId` (body-based routes, e.g. POST /api/channels).
 *
 * Batch 3/E: decided by lib/policy 'workspace.view' (the same rule every
 * other module uses) instead of an inline WorkspaceMember lookup. Behaviour
 * is unchanged: a member (or the owner) passes; the Default Workspace
 * (`isDefault: true`) is open to every authenticated account, which
 * loadWorkspaceActor resolves as an implicit MEMBER (Rule 2). Organization
 * managers who aren't members do NOT pass — this gate guards content routes;
 * management routes call the policy directly.
 */
export const requireWorkspaceAccess = async (req: WorkspaceScopedRequest, res: Response, next: NextFunction) => {
  // Fails closed via next(err) instead of leaving the request hanging —
  // Express 4 does not catch rejected promises from async middleware.
  try {
    await checkWorkspaceAccess(req, res, next);
  } catch (err) {
    next(err);
  }
};

const checkWorkspaceAccess = async (req: WorkspaceScopedRequest, res: Response, next: NextFunction) => {
  const workspaceId = req.params.workspaceId || req.body?.workspaceId;
  if (!workspaceId || typeof workspaceId !== 'string') {
    return res.status(400).json({ error: 'workspaceId is required' });
  }

  let actor: WorkspaceActor;
  try {
    actor = await loadWorkspaceActor(req.user!.id, workspaceId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return res.status(404).json({ error: 'Workspace not found' });
    throw err;
  }
  if (!canWorkspace(actor, 'workspace.view')) {
    return res.status(403).json({ error: 'You are not a member of this workspace.' });
  }

  req.workspaceActor = actor;
  next();
};
