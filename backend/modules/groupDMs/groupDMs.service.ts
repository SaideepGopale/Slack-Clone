import { isUuid } from '../../lib/messageInput';
import { canRemoveGroupDMParticipant } from '../../lib/policy';
import { prisma } from '../../lib/prisma';
import { ChannelAccess } from '../../sockets/channelAccess';
import { ChannelWithMembers } from '../channels/channels.service';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Group direct messages (Batch 2). A group DM is a Channel row with
 * isDM=true and isGroupDM=true, so every existing "DMs never appear in
 * public channel lists / can't be joined via channel endpoints" rule applies
 * to it automatically. Membership changes go through this module only.
 *
 * Rules:
 *  - 3..MAX_PARTICIPANTS participants, all members of the workspace;
 *  - creating a group with exactly the same people returns the existing one;
 *  - any participant can add people (optionally sharing prior history) and
 *    rename the conversation; anyone can leave; only the creator can remove
 *    someone else.
 */
export const MAX_PARTICIPANTS = 9;
const NAME_MAX = 80;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

const memberInclude = {
  // Safe projection (no read positions / history windows), oldest first.
  members: {
    select: { userId: true, role: true, user: { select: { id: true, username: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

const normalizeName = (raw: unknown): string | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new HttpError(400, 'Conversation name must be text.');
  const name = raw.replace(CONTROL_CHARS_RE, '').trim();
  if (name.length > NAME_MAX) throw new HttpError(400, `Conversation name must be at most ${NAME_MAX} characters.`);
  return name || null;
};

const loadConversation = async (channelId: string) =>
  (await prisma.channel.findUnique({ where: { id: channelId }, include: memberInclude })) as ChannelWithMembers | null;

const assertGroup = (access: ChannelAccess) => {
  if (!access.isGroupDM) throw new HttpError(400, 'This action is only available in group conversations.');
};

const assertWorkspaceMembers = async (workspaceId: string, userIds: string[]) => {
  const count = await prisma.workspaceMember.count({ where: { workspaceId, userId: { in: userIds } } });
  if (count !== userIds.length) throw new HttpError(400, 'Everyone in a conversation must be a member of this workspace.');
};

export const createGroupDM = async (creatorId: string, workspaceId: string, rawUserIds: unknown, rawName: unknown) => {
  if (!Array.isArray(rawUserIds) || !rawUserIds.every(isUuid)) {
    throw new HttpError(400, 'userIds must be a list of user ids.');
  }
  const others = Array.from(new Set(rawUserIds as string[])).filter((id) => id !== creatorId);
  if (others.length < 2) throw new HttpError(400, 'A group conversation needs at least two other people. Use a direct message for one person.');
  if (others.length + 1 > MAX_PARTICIPANTS) {
    throw new HttpError(400, `A group conversation can have at most ${MAX_PARTICIPANTS} people.`);
  }
  const name = normalizeName(rawName);
  const participantIds = [creatorId, ...others];
  await assertWorkspaceMembers(workspaceId, participantIds);

  // Same people → same conversation (unnamed requests reuse any match;
  // named requests reuse a match with the same name).
  const candidates = (await prisma.channel.findMany({
    where: { workspaceId, isGroupDM: true, members: { every: { userId: { in: participantIds } } } },
    include: memberInclude,
    orderBy: { createdAt: 'asc' },
  })) as ChannelWithMembers[];
  const existing = candidates.find(
    (c) => c.members.length === participantIds.length && (name === null || c.name === name)
  );
  if (existing) return { channel: existing, created: false };

  const channel = (await prisma.channel.create({
    data: {
      isDM: true,
      isGroupDM: true,
      name,
      createdBy: creatorId,
      workspaceId,
      members: { create: participantIds.map((userId) => ({ userId, role: userId === creatorId ? 'admin' : 'member' })) },
    },
    include: memberInclude,
  })) as ChannelWithMembers;
  return { channel, created: true };
};

export const listParticipants = async (access: ChannelAccess) => {
  if (!access.isDM) throw new HttpError(400, 'Participants are only listed for direct conversations.');
  const members = await prisma.channelMember.findMany({
    where: { channelId: access.channelId },
    select: { userId: true, createdAt: true, user: { select: { username: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    channelId: access.channelId,
    isGroupDM: access.isGroupDM,
    createdBy: access.createdBy,
    name: access.name,
    maxParticipants: MAX_PARTICIPANTS,
    participants: members.map((m) => ({ id: m.userId, username: m.user.username, joinedAt: m.createdAt })),
  };
};

export const addParticipant = async (actorId: string, access: ChannelAccess, targetId: unknown, shareHistory: unknown) => {
  assertGroup(access);
  if (!isUuid(targetId)) throw new HttpError(400, 'A valid userId is required.');
  if (shareHistory !== undefined && typeof shareHistory !== 'boolean') {
    throw new HttpError(400, 'shareHistory must be true or false.');
  }
  await assertWorkspaceMembers(access.workspaceId, [targetId]);

  const current = await prisma.channelMember.findMany({ where: { channelId: access.channelId }, select: { userId: true } });
  if (current.some((m) => m.userId === targetId)) throw new HttpError(400, 'That person is already in this conversation.');
  if (current.length + 1 > MAX_PARTICIPANTS) {
    throw new HttpError(400, `A group conversation can have at most ${MAX_PARTICIPANTS} people.`);
  }

  // Default: the newcomer only sees messages from now on (privacy-safe).
  // P3 (FA-SEC-08): "share history" shares at most what the person adding
  // them can see — never history the actor was never given.
  await prisma.channelMember.create({
    data: {
      userId: targetId,
      channelId: access.channelId,
      role: 'member',
      historyFrom: shareHistory === true ? access.historyFrom : new Date(),
    },
  });
  return { channel: (await loadConversation(access.channelId))!, addedUserId: targetId, actorId };
};

/** Leave (target === actor) or remove someone (creator only). */
export const removeParticipant = async (actorId: string, access: ChannelAccess, targetId: unknown) => {
  assertGroup(access);
  if (!isUuid(targetId)) throw new HttpError(400, 'A valid userId is required.');
  if (!canRemoveGroupDMParticipant(actorId, targetId, access.createdBy)) {
    throw new HttpError(403, 'Only the person who started this conversation can remove others.');
  }
  const deleted = await prisma.channelMember.deleteMany({ where: { channelId: access.channelId, userId: targetId } });
  if (deleted.count === 0) throw new HttpError(404, 'That person is not in this conversation.');
  return { channel: (await loadConversation(access.channelId))!, removedUserId: targetId };
};

export const renameGroup = async (access: ChannelAccess, rawName: unknown) => {
  assertGroup(access);
  const name = normalizeName(rawName);
  await prisma.channel.update({ where: { id: access.channelId }, data: { name } });
  return (await loadConversation(access.channelId))!;
};

export { HttpError };
