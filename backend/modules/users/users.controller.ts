import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as usersService from './users.service';

export const listUsersHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const users = await usersService.listUsers(req.user!.id);
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

// GET /api/users/me/profile — the caller's collaboration profile + preferences.
export const getMyProfileHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await usersService.getProfile(req.user!.id));
  } catch (err) { next(err); }
};

// PATCH /api/users/me/profile — partial update (title, bio, timezone, readReceiptsEnabled).
export const updateMyProfileHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await usersService.updateProfile(req.user!.id, req.body));
  } catch (err) { next(err); }
};
