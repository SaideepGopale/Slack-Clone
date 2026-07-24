import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as usersService from './users.service';

export const listUsersHandler = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const users = await usersService.listUsers();
    res.json(users);
  } catch (err) { next(err); }
};

// PATCH /api/users/me/active-workspace — requireWorkspaceAccess (mounted on
// this route) already confirmed the caller belongs to req.body.workspaceId
// before this handler runs, same guard every other workspace-scoped write
// in this app goes through.
export const updateActiveWorkspaceHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.body;
    await usersService.setLastActiveWorkspace(req.user!.id, workspaceId);
    res.status(204).end();
  } catch (err) { next(err); }
};
