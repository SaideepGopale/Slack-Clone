import { Prisma } from '@prisma/client';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import {
  assertChannel,
  canChangeChannelRole,
  canChannel,
  canLeaveChannel,
  canRemoveChannelMember,
  CHANNEL_ARCHIVED_MESSAGE,
  CHANNEL_ROLES,
  ChannelActor,
  ChannelRoleName,
  effectiveChannelRole,
  loadChannelActor,
  normalizeChannelRole,
} from '../../lib/policy';
import { lockChannelForPlacement } from '../projects/projectGuards';
import { assertChannelNameAvailable, parseChannelName } from './channelNames';
import { channelType, parseDescription, parseFlag, parseIcon, parseTopic, parseVisibility } from './channels.service';

/**
 * Channel management (Batch 3 / Sub-batch D). Every decision is made by
 * lib/policy (channel.ts); this module validates input, applies changes under
 * row locks and records audit entries. Real-time fan-out lives in
 * channelManagement.realtime.ts and is triggered by the routes.
 */

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

const summarySelect = {
  id: true,
  workspaceId: true,
  projectId: true,
  name: true,
  description: true,
  topic: true,
  icon: true,
  visibility: true,
  isAnnouncement: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { members: true } },
} satisfies Prisma.ChannelSelect;

type SummaryRow = Prisma.ChannelGetPayload<{ select: typeof summarySelect }>;

/** Broadcast-safe channel view (no per-viewer fields). */
export const channelSummary = (row: SummaryRow) => ({
  id: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  name: row.name,
  description: row.description,
  topic: row.topic,
  icon: row.icon,
  visibility: row.visibility,
  isAnnouncement: row.isAnnouncement,
  type: channelType(row),
  archived: row.archivedAt !== null,
  archivedAt: row.archivedAt,
  isGeneral: row.name?.trim().toLowerCase() === 'general',
  memberCount: row._count.members,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type ChannelSummary = ReturnType<typeof channelSummary>;

export const loadChannelSummary = async (channelId: string): Promise<ChannelSummary | null> => {
  const row = await prisma.channel.findUnique({ where: { id: channelId }, select: summarySelect });
  return row ? channelSummary(row) : null;
};

const memberSelect = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, username: true } },
} satisfies Prisma.ChannelMemberSelect;

type MemberRow = Prisma.ChannelMemberGetPayload<{ select: typeof memberSelect }>;

// Never lastReadAt / lastReadMessageId / historyFrom (read-position privacy).
export const channelMemberView = (row: MemberRow) => ({
  userId: row.user.id,
  role: normalizeChannelRole(row.role)!,
  joinedAt: row.createdAt,
  user: row.user,
});

export type ChannelMemberView = ReturnType<typeof channelMemberView>;

/** Loads a regular channel the caller may see; DMs have their own participant controls. */
const loadManagedChannel = async (userId: string, channelId: unknown) => {
  const loaded = await loadChannelActor(userId, channelId);
  assertChannel(loaded.actor, 'channel.view');
  if (loaded.actor.kind !== 'channel') {
    throw new HttpError(400, 'Direct messages have no channel settings. Use the conversation details instead.');
  }
  return loaded;
};

const capabilities = (actor: ChannelActor, otherMembers: number) => {
  const role = effectiveChannelRole(actor);
  return {
    canRead: canChannel(actor, 'channel.read'),
    canPost: canChannel(actor, 'channel.post'),
    canReply: canChannel(actor, 'channel.reply'),
    canReact: canChannel(actor, 'channel.react'),
    canJoin: role === null && canChannel(actor, 'channel.join'),
    canLeave: canLeaveChannel(actor, otherMembers),
    canUpdateInfo: canChannel(actor, 'channel.updateInfo'),
    canUpdateSettings: canChannel(actor, 'channel.updateSettings'),
    // General keeps its name and type forever (frozen signup looks it up by name).
    canChangeType: canChannel(actor, 'channel.updateSettings') && !actor.isGeneral,
    canArchive: canChannel(actor, 'channel.archive'),
    canAddMembers: canChannel(actor, 'channel.addMembers'),
    canRemoveMembers: canChannel(actor, 'channel.removeMembers'),
    canChangeRoles: canChannel(actor, 'channel.changeRoles'),
  };
};

const detailsFor = async (actor: ChannelActor) => {
  const row = await prisma.channel.findUnique({
    where: { id: actor.channelId },
    select: {
      ...summarySelect,
      creator: { select: { id: true, username: true } },
      archivedBy: { select: { id: true, username: true } },
      project: { select: { id: true, name: true, visibility: true } },
      members: { where: { role: 'admin' }, select: { user: { select: { id: true, username: true } } }, take: 1 },
    },
  });
  if (!row) throw new HttpError(404, 'Channel not found.');
  const role = effectiveChannelRole(actor);
  const otherMembers = row._count.members - (role ? 1 : 0);
  return {
    ...channelSummary(row),
    owner: row.members[0]?.user ?? null,
    createdBy: row.creator,
    archivedBy: row.archivedBy,
    project: row.project,
    myRole: role,
    capabilities: capabilities(actor, otherMembers),
  };
};

export type ChannelDetails = Awaited<ReturnType<typeof detailsFor>>;

/** GET /api/channels/:id/details */
export const getChannelDetails = async (userId: string, channelId: unknown) => {
  const { actor } = await loadManagedChannel(userId, channelId);
  return detailsFor(actor);
};

/** GET /api/channels/:id/members?q=&cursor=&limit= — same visibility as the channel itself. */
export const listChannelMembers = async (userId: string, channelId: unknown, query: Record<string, unknown>) => {
  const { actor } = await loadManagedChannel(userId, channelId);
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '';
  const n = Number(query.limit);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, PAGE_MAX) : PAGE_DEFAULT;

  let cursor: string | undefined;
  if (query.cursor !== undefined) {
    const anchor = isUuid(query.cursor)
      ? await prisma.channelMember.findFirst({ where: { id: query.cursor, channelId: actor.channelId }, select: { id: true } })
      : null;
    if (!anchor) throw new HttpError(400, 'Invalid cursor.');
    cursor = anchor.id;
  }

  const rows = await prisma.channelMember.findMany({
    where: { channelId: actor.channelId, ...(q ? { user: { username: { contains: q, mode: 'insensitive' } } } : {}) },
    select: memberSelect,
    orderBy: [{ user: { username: 'asc' } }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return { members: page.map(channelMemberView), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
};

export interface ChannelUpdateResult {
  channel: ChannelDetails;
  previous: { visibility: 'PUBLIC' | 'PRIVATE'; projectId: string | null };
  changed: string[];
}

/**
 * PATCH /api/channels/:id
 *  - topic, description, icon → 'channel.updateInfo' (owner, moderators, managers)
 *  - name, visibility, isAnnouncement → 'channel.updateSettings' (owner, managers)
 * General keeps its name and type. Renames and private→public re-run the
 * privacy-aware name check.
 */
export const updateChannel = async (
  userId: string,
  channelId: unknown,
  body: Record<string, unknown> | undefined
): Promise<ChannelUpdateResult> => {
  const { actor, channel } = await loadManagedChannel(userId, channelId);

  const info: Prisma.ChannelUpdateInput = {};
  if (body?.topic !== undefined) info.topic = parseTopic(body.topic);
  if (body?.description !== undefined) info.description = parseDescription(body.description);
  if (body?.icon !== undefined) info.icon = parseIcon(body.icon) ?? 'hash';
  const settings: Prisma.ChannelUpdateInput = {};
  if (body?.name !== undefined) settings.name = parseChannelName(body.name);
  if (body?.visibility !== undefined) settings.visibility = parseVisibility(body.visibility);
  if (body?.isAnnouncement !== undefined) settings.isAnnouncement = parseFlag(body.isAnnouncement, 'isAnnouncement');

  const changed = [...Object.keys(info), ...Object.keys(settings)];
  if (changed.length === 0) throw new HttpError(400, 'Nothing to update.');
  if (Object.keys(info).length > 0) assertChannel(actor, 'channel.updateInfo');
  if (Object.keys(settings).length > 0) {
    assertChannel(actor, 'channel.updateSettings');
    if (actor.isGeneral) throw new HttpError(400, "The General channel's name and type can't be changed.");
  }

  const previous = await prisma.$transaction(async (tx) => {
    const locked = await lockChannelForPlacement(tx, actor.channelId);
    if (!locked) throw new HttpError(404, 'Channel not found.');
    if (locked.archived) throw new HttpError(409, CHANNEL_ARCHIVED_MESSAGE);
    const nextName = (settings.name as string | undefined) ?? channel.name ?? '';
    const becomesPublic = settings.visibility === 'PUBLIC' && locked.visibility === 'PRIVATE';
    if (settings.name !== undefined || becomesPublic) {
      await assertChannelNameAvailable(tx, actor.workspace, nextName, actor.channelId);
    }
    await tx.channel.update({ where: { id: actor.channelId }, data: { ...info, ...settings } });
    return { visibility: locked.visibility, projectId: locked.projectId };
  });

  await logAuditEvent(userId, 'UPDATE_CHANNEL', 'CHANNEL', actor.channelId, `Updated #${channel.name ?? actor.channelId} (${changed.join(', ')})`);
  const { actor: fresh } = await loadChannelActor(userId, actor.channelId);
  return { channel: await detailsFor(fresh), previous, changed };
};

/** POST /api/channels/:id/archive | /restore — idempotent; nothing is deleted. */
export const setChannelArchived = async (userId: string, channelId: unknown, archived: boolean) => {
  const { actor, channel } = await loadManagedChannel(userId, channelId);
  if (actor.isGeneral) throw new HttpError(400, "The General channel can't be archived.");
  assertChannel(actor, 'channel.archive');
  const result = await prisma.channel.updateMany({
    where: { id: actor.channelId, archivedAt: archived ? null : { not: null } },
    data: archived ? { archivedAt: new Date(), archivedById: userId } : { archivedAt: null, archivedById: null },
  });
  const changed = result.count > 0;
  if (changed) {
    await logAuditEvent(userId, archived ? 'ARCHIVE_CHANNEL' : 'RESTORE_CHANNEL', 'CHANNEL', actor.channelId,
      `${archived ? 'Archived' : 'Restored'} #${channel.name ?? actor.channelId}`);
  }
  const { actor: fresh } = await loadChannelActor(userId, actor.channelId);
  return { channel: await detailsFor(fresh), changed };
};

const parseRole = (value: unknown): ChannelRoleName => {
  if (typeof value === 'string' && (CHANNEL_ROLES as readonly string[]).includes(value)) return value as ChannelRoleName;
  throw new HttpError(400, 'role must be admin (owner), moderator or member.');
};

/**
 * PATCH /api/channels/:id/members/:userId { role }
 * member ⇄ moderator, or 'admin' to transfer ownership: the target becomes
 * the Owner and every previous owner becomes a moderator, in one locked
 * transaction. Owner or managers only; never your own role; the owner's role
 * only changes through a transfer.
 */
export const changeChannelMemberRole = async (actorId: string, channelId: unknown, targetIdInput: unknown, roleInput: unknown) => {
  const { actor, channel } = await loadManagedChannel(actorId, channelId);
  assertChannel(actor, 'channel.changeRoles');
  const role = parseRole(roleInput);
  if (!isUuid(targetIdInput)) throw new HttpError(400, 'Invalid user id.');
  const targetId = targetIdInput;
  if (targetId === actorId) throw new HttpError(400, 'You cannot change your own channel role.');

  const row = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId: targetId, channelId: actor.channelId } },
    select: memberSelect,
  });
  if (!row) throw new HttpError(404, 'That person is not in this channel.');
  const current = normalizeChannelRole(row.role)!;
  if (current === role) return { workspaceId: channel.workspaceId, changed: [] as ChannelMemberView[], member: channelMemberView(row) };
  if (current === 'admin') {
    throw new HttpError(400, "The channel owner's role only changes by transferring ownership to another member.");
  }
  if (!canChangeChannelRole(actor, { userId: targetId, role: current }, role)) {
    throw new HttpError(403, 'Only the channel owner or workspace admins can change channel roles.');
  }
  if (role === 'admin') {
    // The new owner must still be able to use the channel (workspace + project).
    const { actor: target } = await loadChannelActor(targetId, actor.channelId);
    if (effectiveChannelRole(target) === null) throw new HttpError(400, 'That person can no longer access this channel.');
  }

  const changedRows = await prisma.$transaction(async (tx) => {
    const locked = await lockChannelForPlacement(tx, actor.channelId);
    if (!locked) throw new HttpError(404, 'Channel not found.');
    if (locked.archived) throw new HttpError(409, CHANNEL_ARCHIVED_MESSAGE);
    const fresh = await tx.channelMember.findUnique({
      where: { userId_channelId: { userId: targetId, channelId: actor.channelId } },
      select: { id: true, role: true },
    });
    if (!fresh || normalizeChannelRole(fresh.role) !== current) {
      throw new HttpError(409, 'That membership changed in the meantime. Refresh and try again.');
    }
    const touched = [fresh.id];
    if (role === 'admin') {
      const previousOwners = await tx.channelMember.findMany({
        where: { channelId: actor.channelId, role: 'admin' },
        select: { id: true },
      });
      await tx.channelMember.updateMany({ where: { channelId: actor.channelId, role: 'admin' }, data: { role: 'moderator' } });
      touched.push(...previousOwners.map((o) => o.id));
    }
    await tx.channelMember.update({ where: { id: fresh.id }, data: { role } });
    return tx.channelMember.findMany({ where: { id: { in: touched } }, select: memberSelect });
  });

  await logAuditEvent(
    actorId,
    role === 'admin' ? 'TRANSFER_CHANNEL_OWNERSHIP' : 'CHANGE_CHANNEL_ROLE',
    'CHANNEL',
    actor.channelId,
    role === 'admin' ? `Transferred ownership of #${channel.name} to user ${targetId}` : `Set user ${targetId} to ${role} in #${channel.name}`
  );
  const views = changedRows.map(channelMemberView);
  return { workspaceId: channel.workspaceId, changed: views, member: views.find((m) => m.userId === targetId)! };
};

/**
 * DELETE /api/channels/:id/members/:userId — owner, moderators (plain
 * members only) or managers, who don't need to be channel members
 * (decision 5). Allowed in archived channels; never the owner; never yourself.
 */
export const removeChannelMember = async (actorId: string, channelId: unknown, targetIdInput: unknown) => {
  const { actor, channel } = await loadChannelActor(actorId, channelId);
  assertChannel(actor, 'channel.view');
  if (actor.kind !== 'channel') throw new HttpError(400, 'Use the conversation participant controls for direct messages.');
  if (actor.isGeneral) throw new HttpError(400, 'Everyone in the workspace stays in General.');
  assertChannel(actor, 'channel.removeMembers');
  if (!isUuid(targetIdInput)) throw new HttpError(400, 'Invalid user id.');
  const targetId = targetIdInput;
  if (targetId === actorId) throw new HttpError(400, 'Use "Leave channel" to remove yourself.');

  const row = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId: targetId, channelId: actor.channelId } },
    select: { role: true },
  });
  if (!row) throw new HttpError(404, 'That person is not in this channel.');
  const targetRole = normalizeChannelRole(row.role)!;
  if (!canRemoveChannelMember(actor, { userId: targetId, role: targetRole })) {
    if (targetRole === 'admin') throw new HttpError(400, 'The channel owner cannot be removed. Transfer ownership first.');
    throw new HttpError(403, 'Moderators can only remove regular members.');
  }

  const deleted = await prisma.channelMember.deleteMany({
    where: { channelId: actor.channelId, userId: targetId, role: { not: 'admin' } },
  });
  if (deleted.count === 0) throw new HttpError(409, 'That membership changed in the meantime. Refresh and try again.');
  await logAuditEvent(actorId, 'REMOVE_CHANNEL_MEMBER', 'CHANNEL', actor.channelId, `Removed user ${targetId} from #${channel.name ?? actor.channelId}`);
  return { channelId: actor.channelId, workspaceId: channel.workspaceId, userId: targetId };
};

/**
 * POST /api/channels/:id/leave (General and DMs are handled by the caller).
 * The owner must transfer ownership first unless nobody else is left.
 */
export const assertCanLeaveChannel = async (userId: string, channelId: string) => {
  const { actor } = await loadChannelActor(userId, channelId);
  if (effectiveChannelRole(actor) !== 'admin') return;
  const others = await prisma.channelMember.count({ where: { channelId, userId: { not: userId } } });
  if (!canLeaveChannel(actor, others)) {
    throw new HttpError(400, 'Transfer channel ownership to another member before leaving.');
  }
};
