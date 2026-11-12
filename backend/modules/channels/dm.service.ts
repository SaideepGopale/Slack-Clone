import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import { ChannelWithMembers } from './channels.service';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Same safe projection as channels.service (no read positions).
const memberInclude = {
  members: { select: { userId: true, role: true, user: { select: { id: true, username: true } } } },
};

// A DM is still a Channel row, so it has to live in a workspace both
// participants actually share — never an arbitrary/default one.
// P2 Phase E: when the client names the workspace (every current client
// does), the DM lives there or nowhere — falling back to some other shared
// workspace used to hand back a conversation from a different workspace
// than the one the user was in. Only legacy clients that send no workspace
// still get the first shared one.
const getSharedWorkspaceId = async (userIdA: string, userIdB: string, preferredWorkspaceId?: string): Promise<string> => {
  if (preferredWorkspaceId !== undefined) {
    if (!isUuid(preferredWorkspaceId)) throw new HttpError(400, 'A valid workspaceId is required.');
    const both = await prisma.workspaceMember.count({
      where: { workspaceId: preferredWorkspaceId, userId: { in: [userIdA, userIdB] } },
    });
    if (both !== 2) throw new HttpError(403, 'You can only message people who are members of this workspace.');
    return preferredWorkspaceId;
  }
  const shared = await prisma.workspaceMember.findFirst({
    where: { userId: userIdA, workspace: { members: { some: { userId: userIdB } } } },
    select: { workspaceId: true },
  });
  if (!shared) {
    throw new HttpError(400, 'You do not share a workspace with this user.');
  }
  return shared.workspaceId;
};

export interface FindOrCreateDMResult {
  channel: ChannelWithMembers;
  created: boolean;
}

/**
 * Returns the existing 1:1 DM between the two users, or creates it.
 *
 * `targetUserId` is validated up front: previously a missing id became an
 * `undefined` Prisma filter (i.e. "no filter") and returned an arbitrary DM.
 */
export const findOrCreateDM = async (
  currentUserId: string,
  targetUserId: unknown,
  preferredWorkspaceId?: string
): Promise<FindOrCreateDMResult> => {
  if (!isUuid(targetUserId)) throw new HttpError(400, 'A valid targetUserId is required.');
  if (targetUserId === currentUserId) throw new HttpError(400, 'Cannot create DM with yourself');

  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!target) throw new HttpError(404, 'User not found');

  const workspaceId = await getSharedWorkspaceId(currentUserId, targetUserId, preferredWorkspaceId);

  // P2 Phase E: one 1:1 DM per pair per workspace. The lookup and the create
  // run under a transaction-scoped advisory lock keyed by (workspace, pair),
  // so concurrent "open DM" requests from either side serialize instead of
  // each creating its own conversation.
  const [first, second] = [currentUserId, targetUserId].sort();
  const lockKey = `dm:${workspaceId}:${first}:${second}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}::text))`;

    const existingDM = await tx.channel.findFirst({
      where: {
        workspaceId,
        isDM: true,
        // Group conversations containing both people are not "the" 1:1 DM.
        isGroupDM: false,
        AND: [{ members: { some: { userId: currentUserId } } }, { members: { some: { userId: targetUserId } } }],
      },
      include: memberInclude,
      orderBy: { createdAt: 'asc' },
    });
    if (existingDM) return { channel: existingDM as ChannelWithMembers, created: false };

    const newDM = await tx.channel.create({
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
    return { channel: newDM as ChannelWithMembers, created: true };
  });
};
