import { prisma } from '../../lib/prisma';
import { getSocketServer, workspaceRoom } from '../../sockets/registry';
import { ChannelMemberView, ChannelSummary, loadChannelSummary } from './channelManagement.service';

/**
 * Real-time fan-out for channel management (Batch 3 / Sub-batch D). The
 * audiences mirror lib/policy 'channel.view', so a private channel's events
 * never reach anyone who couldn't fetch it over REST:
 *
 *   viewers (channel:updated, channel:removed):
 *     PRIVATE channel             → channel members + workspace managers
 *     PUBLIC channel, private project → project members + workspace managers
 *     PUBLIC channel otherwise    → `ws:<id>` room + organization managers
 *   members (channel:members_changed):
 *     channel members + workspace managers (member lists are management data)
 *
 * Workspace managers = workspace owner, workspace ADMINs, organization
 * OWNER/ADMINs (lib/policy canManageWorkspace). Personal `user:<id>` rooms
 * are used for everything except the public workspace room, so a stale
 * channel-room subscription can never widen an audience.
 */

const userRoom = (userId: string) => `user:${userId}`;

interface ChannelAudience {
  workspaceId: string;
  viewers: string[];
  members: string[];
  // Rooms that could see the channel while it was public (for channel:removed).
  publicViewers: string[];
}

const loadAudience = async (channelId: string): Promise<ChannelAudience | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      workspaceId: true,
      visibility: true,
      members: { select: { userId: true } },
      project: { select: { visibility: true, members: { select: { userId: true } } } },
      workspace: {
        select: {
          ownerId: true,
          members: { where: { role: 'ADMIN' }, select: { userId: true } },
          organization: { select: { members: { where: { role: { in: ['OWNER', 'ADMIN'] } }, select: { userId: true } } } },
        },
      },
    },
  });
  if (!channel) return null;
  const organizationManagers = channel.workspace.organization?.members.map((m) => m.userId) ?? [];
  const managers = [channel.workspace.ownerId, ...channel.workspace.members.map((m) => m.userId), ...organizationManagers];
  const unique = (ids: string[]) => [...new Set(ids)].map(userRoom);

  const members = unique([...channel.members.map((m) => m.userId), ...managers]);
  const privateProject = channel.project?.visibility === 'PRIVATE';
  const publicViewers = privateProject
    ? unique([...channel.project!.members.map((m) => m.userId), ...managers])
    : [workspaceRoom(channel.workspaceId), ...unique(organizationManagers)];
  return {
    workspaceId: channel.workspaceId,
    members,
    publicViewers,
    viewers: channel.visibility === 'PRIVATE' ? members : publicViewers,
  };
};

/**
 * After an update/archive/restore. When a channel became PRIVATE, everyone
 * who could see it before but can't now is told to drop it first (disjoint
 * from the new audience, so nobody receives both).
 */
export const announceChannelUpdated = async (
  channelId: string,
  previousVisibility?: 'PUBLIC' | 'PRIVATE',
  changes: string[] = []
) => {
  const io = getSocketServer();
  const [audience, channel] = await Promise.all([loadAudience(channelId), loadChannelSummary(channelId)]);
  if (!io || !audience || !channel) return;
  if (previousVisibility === 'PUBLIC' && channel.visibility === 'PRIVATE') {
    io.to(audience.publicViewers).except(audience.viewers).emit('channel:removed', { channelId, workspaceId: audience.workspaceId });
  }
  io.to(audience.viewers).emit('channel:updated', { channel, changes });
};

export type MembersChange =
  | { change: 'added' | 'role'; member: ChannelMemberView }
  | { change: 'removed'; userId: string };

/** Member list changed (added, removed, left, role/ownership change). */
export const announceMembersChanged = async (channelId: string, changes: MembersChange[]) => {
  const io = getSocketServer();
  if (!io || changes.length === 0) return;
  const audience = await loadAudience(channelId);
  if (!audience) return;
  // A removed member is no longer in the audience but still needs to know.
  const removed = changes.flatMap((c) => (c.change === 'removed' ? [userRoom(c.userId)] : []));
  const rooms = [...new Set([...audience.members, ...removed])];
  for (const change of changes) {
    io.to(rooms).emit('channel:members_changed', { channelId, workspaceId: audience.workspaceId, ...change });
  }
};

export type { ChannelSummary };
