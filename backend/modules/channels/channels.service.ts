import { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logAuditEvent } from '../../lib/auditLog';

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

const memberInclude = {
  members: { include: { user: { select: { id: true, username: true } } } },
};

// DMs are stored as Channel rows with isDM=true; the "name" shown to a user
// is the other participant's username rather than a real channel name.
export const withDisplayName = (channel: ChannelWithMembers, currentUserId: string) => {
  if (!channel.isDM) return channel;
  const otherMember = channel.members.find((m) => m.userId !== currentUserId);
  return { ...channel, name: otherMember ? otherMember.user.username : 'Direct Message' };
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
    where: { isDM: false, members: { some: { userId } } },
    include: memberInclude,
  });
  return (channels as ChannelWithMembers[]).map((c) => withDisplayName(c, userId));
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
    where: { workspaceId, isDM: false, members: { some: { userId } } },
    include: memberInclude,
  });
  return (channels as ChannelWithMembers[]).map((c) => withDisplayName(c, userId));
};

// Powers the Sidebar's "Direct Messages" section — real, already-started 1:1
// conversations only. A DM channel row is only ever created by an explicit
// user action (findOrCreateDM, below in dm.service.ts, called when someone
// clicks "Message" on another person) — there's no background process that
// creates one passively — so its mere existence already means the
// conversation was genuinely started; no extra "has at least one message"
// filter is needed to keep this list free of clutter.
export const listDMsForWorkspace = async (workspaceId: string, userId: string) => {
  const dms = await prisma.channel.findMany({
    where: { workspaceId, isDM: true, members: { some: { userId } } },
    include: memberInclude,
  });

  return (dms as ChannelWithMembers[]).map((dm) => {
    const withName = withDisplayName(dm, userId);
    const otherMember = dm.members.find((m) => m.userId !== userId);
    // Exposed separately from `name` (which withDisplayName already repurposes
    // for display) so the frontend can match this DM to the right entry in
    // its online-users list without re-deriving it from `.members` itself.
    return { ...withName, otherUserId: otherMember?.userId ?? null };
  });
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

// SECURITY FIX: previously `() => prisma.channel.findMany({ where: { isDM:
// false } })` with no workspace filter at all — returned every non-DM
// channel across every workspace to any authenticated user, and (via
// joinChannel below) let them actually join any of them. Now requires the
// caller to be a member of the workspace whose channels they're browsing.
export const listPublicChannels = async (userId: string, workspaceId: string) => {
  const membership = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (!membership) {
    throw new HttpError(403, 'You are not a member of this workspace.');
  }
  return prisma.channel.findMany({ where: { isDM: false, workspaceId } });
};

// "General" is looked up by exact name elsewhere (signup auto-join,
// invitation acceptance) — a second channel sharing that name would make
// those lookups ambiguous, so it's the one name users can't claim.
const RESERVED_CHANNEL_NAMES = new Set(['general']);

export const createChannel = async (
  userId: string,
  workspaceId: string,
  name: string,
  description?: string,
  icon?: string
) => {
  const trimmedName = name?.trim();
  if (!trimmedName) {
    throw new HttpError(400, 'Channel name is required');
  }
  if (trimmedName.length > 80) {
    throw new HttpError(400, 'Channel name must be 80 characters or fewer');
  }
  if (RESERVED_CHANNEL_NAMES.has(trimmedName.toLowerCase())) {
    throw new HttpError(400, '"General" is reserved for the default workspace channel');
  }

  // A real emoji can be several codepoints (skin tone modifiers, ZWJ
  // sequences, flags) — cap generously rather than trying to validate
  // "is this exactly one emoji", which isn't worth the complexity here.
  const trimmedIcon = icon?.trim();
  if (trimmedIcon && trimmedIcon.length > 16) {
    throw new HttpError(400, 'Invalid channel icon');
  }

  // Workspace membership is verified upstream by requireWorkspaceAccess
  // (channels.routes.ts) before this ever runs — no need to re-check it here.

  // Creator becomes the channel's admin/host in the same transaction as
  // creation — there must never be a moment where the channel exists with
  // no one able to administer it.
  return prisma.$transaction(async (tx) => {
    const channel = await tx.channel.create({
      data: {
        name: trimmedName,
        description: description?.trim() || null,
        icon: trimmedIcon || 'hash',
        isDM: false,
        createdBy: userId,
        workspaceId,
      },
    });

    await tx.channelMember.create({
      data: { userId, channelId: channel.id, role: 'admin' },
    });

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

// SECURITY FIX: previously did the upsert with no check at all — any
// authenticated user could join ANY channel in ANY workspace just by
// knowing its id. Now confirms workspace membership first.
export const joinChannel = async (userId: string, channelId: string) => {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { workspaceId: true } });
  if (!channel) {
    throw new HttpError(404, 'Channel not found');
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: channel.workspaceId } },
  });
  if (!membership) {
    throw new HttpError(403, 'You are not a member of the workspace that owns this channel.');
  }

  return prisma.channelMember.upsert({
    where: { userId_channelId: { userId, channelId } },
    update: {},
    create: { userId, channelId, role: 'member' },
  });
};

// Powers AddMemberModal.tsx — every workspace member who isn't already in
// this channel. Gated by the same "channel member or workspace admin" check
// as addChannelMember below, since knowing who's addable is tied to the same
// permission as actually adding them.
export const listAddableMembers = async (requesterId: string, channelId: string) => {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    throw new HttpError(404, 'Channel not found');
  }

  const [requesterChannelMembership, requesterWorkspaceMembership] = await Promise.all([
    prisma.channelMember.findUnique({ where: { userId_channelId: { userId: requesterId, channelId } } }),
    prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: requesterId, workspaceId: channel.workspaceId } },
    }),
  ]);
  const requesterIsChannelMember = !!requesterChannelMembership;
  const requesterIsWorkspaceAdmin = requesterWorkspaceMembership?.role === 'ADMIN';
  if (!requesterIsChannelMember && !requesterIsWorkspaceAdmin) {
    throw new HttpError(403, 'You must be a member of this channel, or a workspace admin, to view its addable members.');
  }

  return prisma.user.findMany({
    where: {
      workspaces: { some: { workspaceId: channel.workspaceId } },
      memberships: { none: { channelId } },
    },
    select: { id: true, username: true, email: true },
    orderBy: { username: 'asc' },
  });
};

// Adds `targetUserId` to a channel they weren't in — the requester must
// either already be a member of that specific channel (any existing member
// can bring others in) or a Workspace Admin (who can staff any channel in
// their workspace, even ones they haven't personally joined). Distinct from
// joinChannel above, which is strictly self-service ("I want to join a
// public channel I found") — this is "someone else adds a person".
export const addChannelMember = async (requesterId: string, channelId: string, targetUserId: string) => {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    throw new HttpError(404, 'Channel not found');
  }

  const [requesterChannelMembership, requesterWorkspaceMembership, targetWorkspaceMembership, targetChannelMembership] =
    await Promise.all([
      prisma.channelMember.findUnique({ where: { userId_channelId: { userId: requesterId, channelId } } }),
      prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: requesterId, workspaceId: channel.workspaceId } },
      }),
      prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: targetUserId, workspaceId: channel.workspaceId } },
      }),
      prisma.channelMember.findUnique({ where: { userId_channelId: { userId: targetUserId, channelId } } }),
    ]);

  const requesterIsChannelMember = !!requesterChannelMembership;
  const requesterIsWorkspaceAdmin = requesterWorkspaceMembership?.role === 'ADMIN';
  if (!requesterIsChannelMember && !requesterIsWorkspaceAdmin) {
    throw new HttpError(403, 'You must be a member of this channel, or a workspace admin, to add people to it.');
  }

  // Can't add someone from outside the workspace — channel membership only
  // ever makes sense for people who belong to the tenant that owns it.
  if (!targetWorkspaceMembership) {
    throw new HttpError(400, 'That user is not a member of this workspace.');
  }

  if (targetChannelMembership) {
    throw new HttpError(400, 'That user is already a member of this channel.');
  }

  const membership = await prisma.channelMember.create({
    data: { userId: targetUserId, channelId, role: 'member' },
    include: { user: { select: { id: true, username: true } } },
  });

  return { membership, channel };
};

export type { ChannelWithMembers };
