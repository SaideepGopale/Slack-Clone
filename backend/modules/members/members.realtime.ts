import { prisma } from '../../lib/prisma';
import { removeWorkspacePresence } from '../../sockets/presence.handlers';
import { notifyUser } from '../../sockets/registry';
import { revokeChannelAccess } from '../../sockets/revocation';
import { ChannelWithMembers, conversationView, memberInclude } from '../channels/channels.service';
import { announceWorkspaceDetachFromProjects } from '../projects/projects.realtime';
import { DetachResult } from './members.service';

/**
 * After a workspace membership ends (removed, left, organization removal):
 * revoke every live room of that workspace for the user, drop them from its
 * presence, tell their clients, and refresh the participant list of any group
 * DM they were removed from. Shared by the members and organizations modules.
 */
export const finishWorkspaceDetach = async (
  userId: string,
  workspaceId: string,
  result: DetachResult,
  reason: 'removed' | 'left'
) => {
  await revokeChannelAccess(userId, result.channelIds);
  removeWorkspacePresence(userId, workspaceId);
  notifyUser(userId, 'workspace:removed', { workspaceId, reason });
  // Batch 3/C: their project memberships in this workspace ended too.
  await announceWorkspaceDetachFromProjects(userId, result.projectIds);
  if (result.groupDMIds.length > 0) {
    const groups = (await prisma.channel.findMany({
      where: { id: { in: result.groupDMIds } },
      include: memberInclude,
    })) as ChannelWithMembers[];
    for (const group of groups) {
      for (const member of group.members) {
        notifyUser(member.userId, 'conversation:updated', conversationView(group, member.userId));
      }
    }
  }
};
