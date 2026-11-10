import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as workspacesService from './workspaces.service';
import { subscribeUserToChannel } from '../../sockets/registry';
import { addWorkspacePresence, removeWorkspacePresence } from '../../sockets/presence.handlers';
import { revokeChannelAccess } from '../../sockets/revocation';
import { notifyUser } from '../../sockets/registry';

export const createWorkspaceHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { name, organizationId, description } = req.body ?? {};
    const result = await workspacesService.createWorkspace(req.user!.id, name, organizationId, description);
    subscribeUserToChannel(req.user!.id, result.generalChannel.id);
    addWorkspacePresence(req.user!.id, result.workspace.id);
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
    const { message, memberIds, channelIds } = await workspacesService.deleteWorkspace(req.user!.id, req.params.workspaceId);
    // Everyone loses the deleted workspace's rooms, presence and UI at once.
    for (const memberId of memberIds) {
      await revokeChannelAccess(memberId, channelIds);
      removeWorkspacePresence(memberId, req.params.workspaceId);
      notifyUser(memberId, 'workspace:removed', { workspaceId: req.params.workspaceId, reason: 'deleted' });
    }
    res.json({ message });
  } catch (err) { next(err); }
};

// GET /api/workspaces/:workspaceId/settings
export const getWorkspaceSettingsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await workspacesService.getWorkspaceSettings(req.user!.id, req.params.workspaceId));
  } catch (err) { next(err); }
};

// PATCH /api/workspaces/:workspaceId { name?, description?, channelCreationPolicy? }
export const updateWorkspaceSettingsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await workspacesService.updateWorkspaceSettings(req.user!.id, req.params.workspaceId, req.body));
  } catch (err) { next(err); }
};
