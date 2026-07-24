import { prisma } from '../../lib/prisma';
import { ChannelWithMembers, withDisplayName } from './channels.service';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const memberInclude = {
  members: { include: { user: { select: { id: true, username: true } } } },
};

// Channel now belongs to a Workspace, and a DM is still a Channel row — it
// has to live in a workspace both participants actually share, not an
// arbitrary/default one, so a DM only ever surfaces to people who could
// otherwise see each other (channel membership, directory, etc.).
const getSharedWorkspaceId = async (userIdA: string, userIdB: string): Promise<string> => {
  const shared = await prisma.workspaceMember.findFirst({
    where: { userId: userIdA, workspace: { members: { some: { userId: userIdB } } } },
    select: { workspaceId: true },
  });
  if (!shared) {
    throw new HttpError(400, 'You do not share a workspace with this user.');
  }
  return shared.workspaceId;
};

export const findOrCreateDM = async (currentUserId: string, targetUserId: string) => {
  const existingDM = await prisma.channel.findFirst({
    where: {
      isDM: true,
      AND: [
        { members: { some: { userId: currentUserId } } },
        { members: { some: { userId: targetUserId } } },
      ],
    },
    include: memberInclude,
  });

  if (existingDM) {
    return withDisplayName(existingDM as ChannelWithMembers, currentUserId);
  }

  const workspaceId = await getSharedWorkspaceId(currentUserId, targetUserId);

  const newDM = await prisma.channel.create({
    data: {
      isDM: true,
      createdBy: currentUserId,
      workspaceId,
      members: {
        create: [
          { userId: currentUserId, role: 'member' },
          { userId: targetUserId, role: 'member' },
        ],
      },
    },
    include: memberInclude,
  });

  return withDisplayName(newDM as ChannelWithMembers, currentUserId);
};
