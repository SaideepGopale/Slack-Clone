import { isUuid } from '../lib/messageInput';
import {
  canChannelContent,
  canManageWorkspace,
  ChannelContentAction,
  channelContentDenial,
  loadWorkspaceActor,
  normalizeChannelRole,
  projectAllowsChannelAccess,
  projectChannelAccessWhere,
} from '../lib/policy';
import { prisma } from '../lib/prisma';
import { AuthenticatedSocket } from './types';

/**
 * Real membership check — one indexed lookup against ChannelMember's
 * compound unique key (`@@unique([userId, channelId])` in schema.prisma).
 */
export const isChannelMember = async (userId: string, channelId: string): Promise<boolean> => {
  const membership = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId } },
    select: { id: true },
  });
  return !!membership;
};

export interface ChannelAccess {
  channelId: string;
  workspaceId: string;
  isDM: boolean;
  isGroupDM: boolean;
  createdBy: string;
  name: string | null;
  role: string;
  // Earliest message this member may see; null = full history.
  historyFrom: Date | null;
  // Batch 3/C: the channel's project (null = workspace level).
  projectId: string | null;
  // Batch 3/D: channel type and lifecycle (DMs: PUBLIC/false/false, unused).
  visibility: 'PUBLIC' | 'PRIVATE';
  isAnnouncement: boolean;
  archived: boolean;
}

/**
 * The single authorization primitive for channel/DM content, used by REST
 * and sockets alike. Returns null unless the user is a member of the channel
 * AND of the workspace that owns it (a ChannelMember row can outlive a
 * workspace membership) AND — for a channel inside a PRIVATE project — of
 * that project (lib/policy projectAllowsChannelAccess). One indexed query.
 */
export const getChannelAccess = async (userId: string, channelId: unknown): Promise<ChannelAccess | null> => {
  if (!isUuid(channelId)) return null;
  const membership = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId } },
    select: {
      role: true,
      historyFrom: true,
      channel: {
        select: {
          workspaceId: true,
          isDM: true,
          isGroupDM: true,
          createdBy: true,
          name: true,
          projectId: true,
          visibility: true,
          isAnnouncement: true,
          archivedAt: true,
          workspace: { select: { members: { where: { userId }, select: { id: true } } } },
          project: { select: { visibility: true, members: { where: { userId }, select: { id: true } } } },
        },
      },
    },
  });
  if (!membership || membership.channel.workspace.members.length === 0) return null;
  const { project } = membership.channel;
  if (!projectAllowsChannelAccess(project, (project?.members.length ?? 0) > 0)) return null;
  return {
    channelId,
    workspaceId: membership.channel.workspaceId,
    isDM: membership.channel.isDM,
    isGroupDM: membership.channel.isGroupDM,
    createdBy: membership.channel.createdBy,
    name: membership.channel.name,
    role: membership.role,
    historyFrom: membership.historyFrom,
    projectId: membership.channel.projectId,
    visibility: membership.channel.visibility,
    isAnnouncement: membership.channel.isAnnouncement,
    archived: membership.channel.archivedAt !== null,
  };
};

/**
 * Batch 3/D content rules (lib/policy canChannelContent) for a member who
 * already passed getChannelAccess: archived channels are read-only, and
 * announcement channels take top-level posts only from owners, moderators
 * and workspace managers. Returns null when allowed, else the reason. The
 * workspace-role lookup only runs for a plain member posting top-level in an
 * announcement channel — the one case where it changes the answer.
 */
export const checkChannelContent = async (
  userId: string,
  access: ChannelAccess,
  action: ChannelContentAction
): Promise<string | null> => {
  const role = normalizeChannelRole(access.role);
  const needsManagerCheck = action === 'post' && access.isAnnouncement && !access.archived && role === 'member';
  const isManager = needsManagerCheck && canManageWorkspace(await loadWorkspaceActor(userId, access.workspaceId));
  const ctx = { role, archived: access.archived, isAnnouncement: access.isAnnouncement, isManager };
  return canChannelContent(ctx, action) ? null : channelContentDenial(ctx);
};

/** Two-layer check (channel + workspace membership) used for every subscription. */
export const canAccessChannel = async (userId: string, channelId: string): Promise<boolean> =>
  (await getChannelAccess(userId, channelId)) !== null;

/** True when `message` falls inside the member's visible history window. */
export const isMessageVisible = (access: Pick<ChannelAccess, 'historyFrom'>, message: { createdAt: Date }) =>
  !access.historyFrom || message.createdAt.getTime() >= access.historyFrom.getTime();

/** Prisma filter restricting messages to the member's visible history window. */
export const visibleHistoryFilter = (access: Pick<ChannelAccess, 'historyFrom'>) =>
  access.historyFrom ? { createdAt: { gte: access.historyFrom } } : {};

/**
 * Room membership is the fast path for authorization: a socket only ever
 * ends up in a channel room after `canAccessChannel` passed for it (either
 * during connection-time subscription or here). On a miss we fall back to
 * the database and subscribe the socket on success, so a channel the user
 * joined after connecting (or a message sent before the initial subscription
 * finished) still works without an explicit `channel:join`.
 *
 * Only UUIDs are accepted, so a client can never pass one of the server's
 * internal room names (`user:<id>`, `call:<id>`, `thread_<id>`) as a channel.
 */
export const ensureChannelAccess = async (socket: AuthenticatedSocket, channelId: unknown): Promise<boolean> => {
  if (!isUuid(channelId)) return false;
  if (socket.rooms.has(channelId)) return true;
  if (!(await canAccessChannel(socket.user.id, channelId))) return false;
  socket.join(channelId);
  return true;
};

/**
 * Subscribes a freshly connected socket to every channel room the user is
 * authorized for. This replaces the old one-room-at-a-time model, where
 * `channel:join` evicted the socket from all other rooms — including its
 * personal `user:<id>` room — breaking unread counts, admin kicks, DM
 * alerts and call signaling (audit RT-01). Because it runs on every
 * (re)connection, subscriptions are restored automatically after a network
 * interruption (audit RT-02).
 */
export const subscribeToMemberChannels = async (socket: AuthenticatedSocket): Promise<string[]> => {
  const userId = socket.user.id;
  const rows = await prisma.channelMember.findMany({
    where: { userId, channel: { workspace: { members: { some: { userId } } }, ...projectChannelAccessWhere(userId) } },
    select: { channelId: true },
  });
  const channelIds = rows.map((r) => r.channelId);
  if (channelIds.length > 0) socket.join(channelIds);
  return channelIds;
};

interface UnauthorizedDetails {
  event: string;
  channelId: string;
  message?: string;
}

export const rejectUnauthorized = (socket: AuthenticatedSocket, details: UnauthorizedDetails) => {
  socket.emit('error:unauthorized', {
    event: details.event,
    channelId: details.channelId,
    message: details.message ?? 'You are not a member of this channel.',
  });
};
