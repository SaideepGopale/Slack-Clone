import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as channelsService from './channels.service';
import { findOrCreateDM } from './dm.service';
import { notifyChannelMemberAdded } from '../../sockets/registry';

export const listChannelsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const channels = await channelsService.listChannelsForUser(req.user!.id);
    res.json(channels);
  } catch (err) { next(err); }
};

// workspaceId presence + membership is already verified by
// requireWorkspaceAccess (channels.routes.ts) before this handler runs.
export const createChannelHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId, name, description, icon } = req.body;
    const channel = await channelsService.createChannel(req.user!.id, workspaceId, name, description, icon);
    res.status(201).json(channel);
  } catch (err) { next(err); }
};

export const listChannelsForWorkspaceHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const channels = await channelsService.listChannelsForWorkspace(req.params.workspaceId, req.user!.id);
    res.json(channels);
  } catch (err) { next(err); }
};

// GET /api/workspaces/:workspaceId/dms — real, already-started DM
// conversations for the caller, kept entirely separate from the public
// channels list above (see listDMsForWorkspace's comment for why).
export const listDMsForWorkspaceHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const dms = await channelsService.listDMsForWorkspace(req.params.workspaceId, req.user!.id);
    res.json(dms);
  } catch (err) { next(err); }
};

export const listAllChannelsAdminHandler = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const channels = await channelsService.listAllChannelsAdmin();
    res.json(channels);
  } catch (err) { next(err); }
};

export const listPublicChannelsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId || typeof workspaceId !== 'string') {
      return res.status(400).json({ error: 'workspaceId query parameter is required' });
    }
    const channels = await channelsService.listPublicChannels(req.user!.id, workspaceId);
    res.json(channels);
  } catch (err) { next(err); }
};

export const createDMHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { targetUserId } = req.body;
    const currentUserId = req.user!.id;
    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: 'Cannot create DM with yourself' });
    }
    const dm = await findOrCreateDM(currentUserId, targetUserId);
    res.json(dm);
  } catch (err) { next(err); }
};

export const deleteChannelHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await channelsService.deleteChannel(req.user!.id, req.params.id);
    if ('notFound' in result) return res.status(404).json({ error: 'Channel not found' });
    if ('protected' in result) return res.status(403).json({ error: 'Cannot delete the general channel' });
    res.json({ message: 'Channel deleted successfully' });
  } catch (err) { next(err); }
};

export const joinChannelHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const membership = await channelsService.joinChannel(req.user!.id, req.params.id);
    res.json(membership);
  } catch (err) { next(err); }
};

export const listAddableMembersHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const users = await channelsService.listAddableMembers(req.user!.id, req.params.channelId);
    res.json(users);
  } catch (err) { next(err); }
};

export const addChannelMemberHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.body;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { membership, channel } = await channelsService.addChannelMember(req.user!.id, req.params.channelId, userId);
    notifyChannelMemberAdded(userId, channel);
    res.status(201).json(membership);
  } catch (err) { next(err); }
};
