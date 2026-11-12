import { NextFunction, Response, Router } from 'express';
import { ChannelScopedRequest, requireChannelMembership } from '../../middleware/channelAccess.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { requireWorkspaceAccess, WorkspaceScopedRequest } from '../../middleware/workspace.middleware';
import { revokeChannelAccess } from '../../sockets/revocation';
import { notifyDMCreated, notifyUser, subscribeUserToChannel } from '../../sockets/registry';
import { ChannelWithMembers, conversationView } from '../channels/channels.service';
import * as groupDMs from './groupDMs.service';

const router = Router();
const writeLimiter = userRateLimit(60, 60_000, 'Too many conversation changes. Please slow down.');

// Every participant gets the conversation rendered for them (display name
// excludes themselves), via their personal user room.
const broadcastConversationUpdate = (channel: ChannelWithMembers) => {
  for (const member of channel.members) {
    notifyUser(member.userId, 'conversation:updated', conversationView(channel, member.userId));
  }
};

// POST /api/workspaces/:workspaceId/group-dms { userIds, name? }
router.post(
  '/workspaces/:workspaceId/group-dms',
  ...requireSessionUser,
  writeLimiter,
  requireWorkspaceAccess,
  async (req: WorkspaceScopedRequest, res: Response, next: NextFunction) => {
    try {
      const creatorId = req.user!.id;
      const { channel, created } = await groupDMs.createGroupDM(creatorId, req.params.workspaceId, req.body?.userIds, req.body?.name);
      for (const member of channel.members) subscribeUserToChannel(member.userId, channel.id);
      if (created) {
        for (const member of channel.members) {
          if (member.userId !== creatorId) {
            notifyDMCreated(member.userId, { ...conversationView(channel, member.userId), lastMessage: null, lastActivityAt: channel.createdAt });
          }
        }
      }
      res.status(created ? 201 : 200).json({ ...conversationView(channel, creatorId), created });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/channels/:id/participants — DM / group DM participants only.
router.get(
  '/channels/:id/participants',
  ...requireSessionUser,
  requireChannelMembership,
  async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await groupDMs.listParticipants(req.channelAccess!));
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/channels/:id/participants { userId, shareHistory? }
router.post(
  '/channels/:id/participants',
  ...requireSessionUser,
  writeLimiter,
  requireChannelMembership,
  async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
    try {
      const { channel, addedUserId } = await groupDMs.addParticipant(
        req.user!.id,
        req.channelAccess!,
        req.body?.userId,
        req.body?.shareHistory
      );
      subscribeUserToChannel(addedUserId, channel.id);
      notifyDMCreated(addedUserId, { ...conversationView(channel, addedUserId), lastMessage: null, lastActivityAt: new Date() });
      broadcastConversationUpdate(channel);
      res.status(201).json(conversationView(channel, req.user!.id));
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/channels/:id/participants/:userId — leave (self) or remove (creator).
router.delete(
  '/channels/:id/participants/:userId',
  ...requireSessionUser,
  writeLimiter,
  requireChannelMembership,
  async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
    try {
      const { channel, removedUserId } = await groupDMs.removeParticipant(req.user!.id, req.channelAccess!, req.params.userId);
      // Immediate revocation: rooms, threads and calls of this conversation.
      await revokeChannelAccess(removedUserId, [channel.id]);
      notifyUser(removedUserId, 'conversation:removed', { channelId: channel.id });
      broadcastConversationUpdate(channel);
      res.json({ removed: true, channelId: channel.id, userId: removedUserId });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/channels/:id/conversation { name } — rename a group DM.
router.patch(
  '/channels/:id/conversation',
  ...requireSessionUser,
  writeLimiter,
  requireChannelMembership,
  async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
    try {
      const channel = await groupDMs.renameGroup(req.channelAccess!, req.body?.name);
      broadcastConversationUpdate(channel);
      res.json(conversationView(channel, req.user!.id));
    } catch (err) {
      next(err);
    }
  }
);

export default router;
