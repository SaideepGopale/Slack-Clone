import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as workspacesService from './workspaces.service';

export const createWorkspaceHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { name } = req.body;
    const result = await workspacesService.createWorkspace(req.user!.id, name);
    res.status(201).json(result);
  } catch (err) { next(err); }
};

export const listWorkspacesHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const workspaces = await workspacesService.listWorkspacesForUser(req.user!.id);
    res.json(workspaces);
  } catch (err) { next(err); }
};

export const deleteWorkspaceHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await workspacesService.deleteWorkspace(req.user!.id, req.params.workspaceId);
    res.json(result);
  } catch (err) { next(err); }
};
