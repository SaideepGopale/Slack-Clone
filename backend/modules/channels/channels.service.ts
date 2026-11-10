import { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logAuditEvent } from '../../lib/auditLog';
import { htmlToPlainText } from '../../lib/sanitize';
import { isUuid } from '../../lib/messageInput';
import {
  assertChannel,
  canAddChannelMember,
  canSeeWorkspaceMemberEmails,
  CHANNEL_ARCHIVED_MESSAGE,
  DirectoryViewer,
  discoverableChannelsWhere,
  effectiveChannelRole,
  loadChannelActor,
  loadWorkspaceActor,
  projectChannelAccessWhere,
  visibleEmail,
  WorkspaceActor,
} from '../../lib/policy';
import { lockChannelForEntry, projectAdmitsUser } from '../projects/projectGuards';
import { assertChannelNameAvailable, parseChannelName } from './channelNames';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Infer member type from Prisma's return type
type ChannelWithMembers = Awaited<ReturnType<PrismaClient['channel']['findMany']>>[number] & {
  members: Array<{ userId: string; user: { id: string; username: string } }>;
};

// Explicit projection — never the whole ChannelMember row: it carries each
// member's private read position (lastReadAt/lastReadMessageId) and history
// window, which must not leak through channel/DM listings or events.
export const memberInclude = {
  members: { select: { userId: true, role: true, user: { select: { id: true, username: true } } } },
};

// P3: channel LISTS (never DMs) carry a member count, not the roster — in
// SmartConnect Collab every user is in the default channels, so the roster
// made every sidebar load grow with the total number of users. (Display
// names only need members for DMs; see withDisplayName.)
export const channelListInclude = { _count: { select: { members: true } } } as const;

// DMs are stored as Channel rows with isDM=true; the "name" shown to a user
// is the other participant's username rather than a real channel name. A
// group DM shows its custom name if it has one, otherwise the other
// participants' usernames.
export const conversationDisplayName = (channel: ChannelWithMembers, currentUserId: string): string => {
  const others = channel.members.filter((m) => m.userId !== currentUserId).map((m) => m.user.username);
  if (channel.isGroupDM) {
    if (channel.name) return channel.name;
    return others.length ? others.sort((a, b) => a.localeCompare(b)).join(', ') : 'Just you';
  }
  return others[0] ?? 'Direct Message';
};

export const withDisplayName = (channel: ChannelWithMembers, currentUserId: string) => {
  if (!channel.isDM) return channel;
  return { ...channel, name: conversationDisplayName(channel, currentUserId), customName: channel.isGroupDM ? channel.name : null };
};

/**
 * The shape of a DM / group DM as seen by one participant — used by the DM
 * list and by every real-time conversation event, so the client can upsert
 * it directly. Never includes message content.
 */
export const conversationView = (channel: ChannelWithMembers, viewerId: string) => {
  const otherMember = channel.isGroupDM ? undefined : channel.members.find((m) => m.userId !== viewerId);
  return {
    ...withDisplayName(channel, viewerId),
    // 1:1 only — lets the client match the conversation to presence.
    otherUserId: otherMember?.userId ?? null,
    participants: channel.members.map((m) => ({ id: m.user.id, username: m.user.username })),
  };
};

// SECURITY/CORRECTNESS FIX: previously had no isDM filter at all — returned
// DM channels mixed in with public ones. Since withDisplayName (above)
// overwrites a DM's `name` with the other participant's username for
// display, any caller treating this list as "public channels" (ActivityView.tsx
// labels messages by `channel.name`) would show a DM as if it were a real
// named channel like "# Samarth Karale". Public-channel listings now exclude
// DMs entirely; use listDMsForWorkspace below to list DM conversations.
export const listChannelsForUser = async (userId: string) => {
  const channels = await prisma.channel.findMany({
    where: { isDM: false, members: { some: { userId } }, ...projectChannelAccessWhere(userId) },
    include: channelListInclude,
  });
  return channels;
};

// Same "my channels" semantics as listChannelsForUser above, scoped to one
// workspace — the route this backs sits behind requireWorkspaceAccess
// (workspace.middleware.ts), so by the time this runs, membership in
// `workspaceId` is already confirmed; this only needs to filter to it.
//
// SECURITY/CORRECTNESS FIX: same isDM leak as listChannelsForUser above —
// this is what powered the Sidebar's "CHANNELS" list, so a DM channel here
// rendered as a bogus public channel named after the other person.
export const listChannelsForWorkspace = async (workspaceId: string, userId: string) => {
  const channels = await prisma.channel.findMany({
    where: { workspaceId, isDM: false, members: { some: { userId } }, ...projectChannelAccessWhere(userId) },
    include: channelListInclude,
  });
  return channels;
};

// Powers the Sidebar's "Direct Messages" section — real, already-started 1:1
// conversations only. A DM channel row is only ever created by an explicit
// user action (findOrCreateDM, below in dm.service.ts, called when someone
// clicks "Message" on another person) — there's no background process that
// creates one passively — so its mere existence already means the
// conversation was genuinely started; no extra "has at least one message"
// filter is needed to keep this list free of clutter.
interface LastMessageRow {
  id: string;
  channelId: string;
  content: string | null;
  fileName: string | null;
  senderId: string;
  createdAt: Date;
}

// Newest top-level message per channel in ONE query (DISTINCT ON walks the
// (channelId, createdAt desc, id desc) index) — avoids both N queries and
// Prisma's nested `take`, which would load every message of every DM.
// Restricted to the viewer's visible-history window, so a group DM member
// added without history never sees a preview of an older message.
const fetchLastMessages = async (channelIds: string[], viewerId: string): Promise<Map<string, LastMessageRow>> => {
  if (channelIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<LastMessageRow[]>`
    SELECT DISTINCT ON (m."channelId") m."id", m."channelId", m."content", m."fileName", m."senderId", m."createdAt"
    FROM "Message" m
    JOIN "ChannelMember" cm ON cm."channelId" = m."channelId" AND cm."userId" = ${viewerId}
    WHERE m."channelId" = ANY(${channelIds}::text[])
      AND m."parentId" IS NULL
      AND (cm."historyFrom" IS NULL OR m."createdAt" >= cm."historyFrom")
    ORDER BY m."channelId", m."createdAt" DESC, m."id" DESC
  `;
  return new Map(rows.map((r) => [r.channelId, r]));
};

const previewText = (row: LastMessageRow): string => {
  const text = htmlToPlainText(row.content);
  if (text) return text.length > 140 ? `${text.slice(0, 137)}...` : text;
  return row.fileName ? `Attachment: ${row.fileName}` : 'Message';
};

/**
 * The caller's DM conversations in this workspace, most recently active
 * first, each with a plain-text preview of its latest message. Only DMs the
 * caller participates in are ever returned (members.some userId filter).
 */
export const listDMsForWorkspace = async (workspaceId: string, userId: string) => {
  const dms = (await prisma.channel.findMany({
    where: { workspaceId, isDM: true, members: { some: { userId } } },
    include: memberInclude,
  })) as ChannelWithMembers[];

  const lastMessages = await fetchLastMessages(dms.map((dm) => dm.id), userId);

  return dms
    .map((dm) => {
      const last = lastMessages.get(dm.id);
      return {
        ...conversationView(dm, userId),
        lastMessage: last
          ? { id: last.id, preview: previewText(last), senderId: last.senderId, createdAt: last.createdAt }
          : null,
        lastActivityAt: last?.createdAt ?? dm.createdAt,
      };
    })
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
};

// Direct messages are private, fixed-membership conversations: nobody can
// self-join one or be added to one through the channel membership endpoints
// (audit SEC-03 — previously any workspace member who knew a DM id could
// join it and read its whole history).
const assertNotDirectMessage = (channel: { isDM: boolean }) => {
  if (channel.isDM) {
    throw new HttpError(403, 'Direct message conversations cannot be joined or extended.');
  }
};

// Admin listing only needs a member *count*, not the full roster — pulling
// every member + user row here (like memberInclude does for the regular
// sidebar listing) would be wasted joins for a table that only displays a
// number.
export const listAllChannelsAdmin = () =>
  prisma.channel.findMany({
    where: { isDM: false },
    include: { _count: { select: { members: true } } },
    orderBy: { createdAt: 'desc' },
  });

// Browse/discovery list (Batch 3/D). Public channels the caller's project
// access allows, plus private channels they belong to; workspace managers
// also see private channels (management metadata only — they still can't
// read or join them). Archived channels are excluded unless asked for
// (?archived=true). Still requires a WorkspaceMember row, as before.
export const listPublicChannels = async (userId: string, workspaceId: string, archived = false) => {
  const membership = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (!membership) {
    throw new HttpError(403, 'You are not a member of this workspace.');
  }
  const workspace = await loadWorkspaceActor(userId, workspaceId);
  const rows = await prisma.channel.findMany({
    where: { AND: [discoverableChannelsWhere(workspace), { archivedAt: archived ? { not: null } : null }] },
    include: { _count: { select: { members: true } }, members: { where: { userId }, select: { role: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return rows.map(({ _count, members, ...channel }) => ({
    ...channel,
    type: channelType(channel),
    memberCount: _count.members,
    isMember: members.length > 0,
    myRole: members[0]?.role ?? null,
  }));
};

export const channelType = (channel: { visibility: 'PUBLIC' | 'PRIVATE'; isAnnouncement: boolean }) =>
  channel.isAnnouncement ? ('ANNOUNCEMENT' as const) : channel.visibility;

const TOPIC_MAX = 250;
const DESCRIPTION_MAX = 500;

export const parseOptionalText = (value: unknown, field: string, max: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return text || null;
};
export const parseTopic = (value: unknown) => parseOptionalText(value, 'Topic', TOPIC_MAX);
export const parseDescription = (value: unknown) => parseOptionalText(value, 'Description', DESCRIPTION_MAX);

// A real emoji can be several codepoints (skin tone modifiers, ZWJ
// sequences, flags) — cap generously rather than trying to validate
// "is this exactly one emoji", which isn't worth the complexity here.
export const parseIcon = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 16) throw new HttpError(400, 'Invalid channel icon');
  return value.trim() || null;
};

export const parseVisibility = (value: unknown): 'PUBLIC' | 'PRIVATE' => {
  if (value === 'PUBLIC' || value === 'PRIVATE') return value;
  throw new HttpError(400, 'visibility must be PUBLIC or PRIVATE.');
};

export const parseFlag = (value: unknown, field: string): boolean => {
  if (typeof value === 'boolean') return value;
  throw new HttpError(400, `${field} must be true or false.`);
};

export interface CreateChannelInput {
  name: unknown;
  description?: unknown;
  icon?: unknown;
  topic?: unknown;
  visibility?: unknown;
  isAnnouncement?: unknown;
  // Already authorized by the controller (lib/policy 'project.createChannel').
  projectId?: string | null;
}

/**
 * Creates a channel; the creator becomes its Owner ('admin') in the same
 * transaction. The caller has already passed 'workspace.createChannel' (and
 * 'project.createChannel' for a project). Names are unique among the
 * channels the creator can see (channelNames.ts).
 */
export const createChannel = async (workspace: WorkspaceActor, input: CreateChannelInput) => {
  const userId = workspace.userId;
  const name = parseChannelName(input.name);
  const description = parseDescription(input.description);
  const topic = parseTopic(input.topic);
  const icon = parseIcon(input.icon);
  const visibility = input.visibility === undefined ? 'PUBLIC' : parseVisibility(input.visibility);
  const isAnnouncement = input.isAnnouncement === undefined ? false : parseFlag(input.isAnnouncement, 'isAnnouncement');
  const projectId = input.projectId ?? null;

  return prisma.$transaction(async (tx) => {
    // Lock order: project row, then the workspace name lock. Re-checked under
    // the project lock: a creator removed from a private project a moment ago
    // must not end up inside one of its channels.
    if (projectId && !(await projectAdmitsUser(tx, projectId, userId))) {
      throw new HttpError(404, 'Project not found.');
    }
    await assertChannelNameAvailable(tx, workspace, name);
    const channel = await tx.channel.create({
      data: {
        name,
        description,
        topic,
        icon: icon || 'hash',
        visibility,
        isAnnouncement,
        isDM: false,
        createdBy: userId,
        workspaceId: workspace.workspaceId,
        projectId,
      },
    });
    await tx.channelMember.create({ data: { userId, channelId: channel.id, role: 'admin' } });
    return channel;
  });
};

export const deleteChannel = async (adminId: string, channelId: string) => {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return { notFound: true as const };
  if (channel.name && channel.name.toLowerCase() === 'general') {
    return { protected: true as const };
  }
  await prisma.channel.delete({ where: { id: channelId } });
  await logAuditEvent(adminId, 'DELETE_CHANNEL', 'CHANNEL', channelId, `Deleted channel "#${channel.name ?? channelId}"`);
  return { deleted: true as const };
};

// Self-service join (Batch 3/D: lib/policy 'channel.join'). DMs are never
// joinable (403, as before); a private channel answers exactly like a missing
// one (404); an archived channel is read-only (409).
export const joinChannel = async (userId: string, channelId: string) => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { workspaceId: true, isDM: true },
  });
  if (!channel) {
    throw new HttpError(404, 'Channel not found');
  }
  assertNotDirectMessage(channel);

  const membership = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: channel.workspaceId } },
  });
  if (!membership) {
    throw new HttpError(403, 'You are not a member of the workspace that owns this channel.');
  }

  const { actor } = await loadChannelActor(userId, channelId);
  if (effectiveChannelRole(actor) === null) assertChannel(actor, 'channel.join');

  return prisma.$transaction(async (tx) => {
    // Batch 3/C: a channel inside a PRIVATE project can only be joined by
    // project members; everyone else gets the same 404 as a missing channel.
    const locked = await lockChannelForEntry(tx, channelId);
    if (!locked || (locked.projectId && !(await projectAdmitsUser(tx, locked.projectId, userId)))) {
      throw new HttpError(404, 'Channel not found');
    }
    if (locked.archived) throw new HttpError(409, CHANNEL_ARCHIVED_MESSAGE);
    return tx.channelMember.upsert({
      where: { userId_channelId: { userId, channelId } },
      update: {},
      create: { userId, channelId, role: 'member' },
    });
  });
};

/** Loads the actor for an add-member style action; DMs keep their historical 403. */
const loadActorForMembership = async (requesterId: string, channelId: string) => {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { isDM: true } });
  if (!channel) throw new HttpError(404, 'Channel not found');
  assertNotDirectMessage(channel);
  return loadChannelActor(requesterId, channelId);
};

// Powers AddMemberModal.tsx — workspace members who could be added (same
// permission as adding: lib/policy 'channel.addMembers').
export const listAddableMembers = async (requesterId: string, channelId: string) => {
  const { actor, channel } = await loadActorForMembership(requesterId, channelId);
  assertChannel(actor, 'channel.addMembers');
  const privateProject = channel.projectId
    ? (await prisma.project.findUnique({ where: { id: channel.projectId }, select: { visibility: true } }))?.visibility === 'PRIVATE'
    : false;
  // P1-D (FA-SEC-03): any member may add people to a public channel, but only
  // workspace managers see e-mails here (lib/policy canSeeWorkspaceMemberEmails).
  const viewer: DirectoryViewer = { id: requesterId, canSeeEmails: canSeeWorkspaceMemberEmails(actor.workspace) };

  const users = await prisma.user.findMany({
    where: {
      workspaces: { some: { workspaceId: channel.workspaceId } },
      memberships: { none: { channelId } },
      // Managers can't add themselves to a private channel.
      ...(actor.visibility === 'PRIVATE' ? { id: { not: requesterId } } : {}),
      // Batch 3/C: only project members can be added to a private project's channels.
      ...(privateProject ? { projectMemberships: { some: { projectId: channel.projectId! } } } : {}),
    },
    select: { id: true, username: true, email: true },
    orderBy: { username: 'asc' },
  });
  return users.map((u) => ({ id: u.id, username: u.username, email: visibleEmail(viewer, u) }));
};

// Someone adds `targetUserId` (lib/policy 'channel.addMembers' +
// canAddChannelMember): any member or manager for a public channel; the
// owner, moderators or managers for a private one. Never into an archived
// channel. Distinct from joinChannel above (self-service).
export const addChannelMember = async (requesterId: string, channelId: string, targetUserId: string) => {
  const { actor } = await loadActorForMembership(requesterId, channelId);
  assertChannel(actor, 'channel.addMembers');
  if (!isUuid(targetUserId)) throw new HttpError(400, 'Invalid user id.');
  if (!canAddChannelMember(actor, targetUserId)) {
    throw new HttpError(403, 'Workspace admins manage private channels but cannot add themselves to them.');
  }

  const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
  const [targetWorkspaceMembership, targetChannelMembership] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: targetUserId, workspaceId: channel.workspaceId } },
    }),
    prisma.channelMember.findUnique({ where: { userId_channelId: { userId: targetUserId, channelId } } }),
  ]);

  // Can't add someone from outside the workspace — channel membership only
  // ever makes sense for people who belong to the tenant that owns it.
  if (!targetWorkspaceMembership) {
    throw new HttpError(400, 'That user is not a member of this workspace.');
  }

  if (targetChannelMembership) {
    throw new HttpError(400, 'That user is already a member of this channel.');
  }

  const membership = await prisma.$transaction(async (tx) => {
    // Batch 3/C: same project gate as joinChannel, evaluated for the target.
    const locked = await lockChannelForEntry(tx, channelId);
    if (!locked) throw new HttpError(404, 'Channel not found');
    if (locked.archived) throw new HttpError(409, CHANNEL_ARCHIVED_MESSAGE);
    if (locked.projectId && !(await projectAdmitsUser(tx, locked.projectId, targetUserId))) {
      throw new HttpError(400, 'That person must be a member of this private project before they can join its channels.');
    }
    return tx.channelMember.create({
      data: { userId: targetUserId, channelId, role: 'member' },
      select: { id: true, userId: true, channelId: true, role: true, createdAt: true, user: { select: { id: true, username: true } } },
    });
  });

  return { membership, channel };
};

export type { ChannelWithMembers };
