import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { assertWorkspace, loadWorkspaceActor } from '../../lib/policy';
import * as channelsService from './channels.service';
import { findOrCreateDM } from './dm.service';
import { notifyChannelMemberAdded, notifyDMCreated, subscribeUserToChannel } from '../../sockets/registry';
import { assertCanCreateChannelInProject } from '../projects/projects.service';
import { announceChannelPlacement } from '../projects/projects.realtime';
import { projectChannelView } from '../projects/projects.views';
import { announceMembersChanged } from './channelManagement.realtime';
import { channelMemberView } from './channelManagement.service';
import { prisma } from '../../lib/prisma';

/** Batch 3/D: tells the channel's member audience that someone joined / was added. */
const announceMemberJoined = async (channelId: string, userId: string) => {
  const row = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId } },
    select: { id: true, role: true, createdAt: true, user: { select: { id: true, username: true } } },
  });
  if (row) await announceMembersChanged(channelId, [{ change: 'added', member: channelMemberView(row) }]);
};

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
    const { workspaceId, name, description, icon, projectId, topic, visibility, isAnnouncement } = req.body;
    // Workspace setting (Batch 3/B): channelCreationPolicy MEMBERS | ADMINS.
    const workspace = await loadWorkspaceActor(req.user!.id, workspaceId);
    assertWorkspace(workspace, 'workspace.createChannel');
    // Batch 3/C: optional project (same workspace, 'project.createChannel').
    const targetProjectId =
      projectId === undefined || projectId === null || projectId === ''
        ? null
        : await assertCanCreateChannelInProject(req.user!.id, workspaceId, projectId);
    const channel = await channelsService.createChannel(workspace, {
      name,
      description,
      icon,
      topic,
      visibility,
      isAnnouncement,
      projectId: targetProjectId,
    });
    subscribeUserToChannel(req.user!.id, channel.id);
    if (targetProjectId) {
      await announceChannelPlacement(
        { projectId: targetProjectId, workspaceId, channel: projectChannelView(channel), moved: true, visibility: channel.visibility },
        true
      );
    }
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
    const channels = await channelsService.listPublicChannels(req.user!.id, workspaceId, req.query.archived === 'true');
    res.json(channels);
  } catch (err) { next(err); }
};

export const createDMHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { targetUserId, workspaceId } = req.body ?? {};
    const currentUserId = req.user!.id;
    const { channel, created } = await findOrCreateDM(
      currentUserId,
      targetUserId,
      typeof workspaceId === 'string' ? workspaceId : undefined
    );

    // Both participants' live sockets start receiving this DM immediately.
    for (const member of channel.members) subscribeUserToChannel(member.userId, channel.id);
    if (created) {
      for (const member of channel.members) {
        if (member.userId === currentUserId) continue;
        notifyDMCreated(member.userId, {
          ...channelsService.conversationView(channel, member.userId),
          lastMessage: null,
          lastActivityAt: channel.createdAt,
        });
      }
    }

    res.json(channelsService.conversationView(channel, currentUserId));
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
    subscribeUserToChannel(req.user!.id, req.params.id);
    await announceMemberJoined(req.params.id, req.user!.id);
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
    subscribeUserToChannel(userId, channel.id);
    notifyChannelMemberAdded(userId, channel);
    await announceMemberJoined(channel.id, userId);
    res.status(201).json(membership);
  } catch (err) { next(err); }
};
