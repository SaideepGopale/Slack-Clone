import { prisma } from '../lib/prisma';
import { AuthenticatedSocket } from './types';

/**
 * Real membership check — one indexed lookup against ChannelMember's
 * compound unique key (`@@unique([userId, channelId])` in schema.prisma).
 * `findUnique` on that key hits exactly one index entry (the fastest access
 * path Postgres/Prisma can offer here), and `select: { id: true }` keeps the
 * query from pulling back columns we don't need (role, isDM, timestamps).
 *
 * This is the only place that hits the database. Everywhere else in a
 * channel's socket handlers should use `isInChannelRoom` instead (see below).
 */
export const isChannelMember = async (userId: string, channelId: string): Promise<boolean> => {
  const membership = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId } },
    select: { id: true },
  });
  return !!membership;
};

/**
 * Cheap stand-in for a fresh membership check: true if this socket already
 * sits in the channel's Socket.IO room. Since joining that room (`channel:join`,
 * see channels.handlers.ts) requires passing *both* `isChannelMember` and a
 * WorkspaceMember check first, a socket can only be "in the room" if it was
 * DB-verified — at the channel level *and* the tenant/workspace level — at
 * join time. Every message event downstream (messages.handlers.ts) gets that
 * same two-layer authorization for free, with zero extra DB round-trips.
 *
 * This is also the actual cross-tenant isolation mechanism: room names are
 * the channel's raw id (a globally unique UUID), so "Workspace A - General"
 * and "Workspace B - General" are structurally different rooms that can
 * never collide — `io.to(roomA).emit(...)` physically cannot reach a socket
 * that only ever joined roomB. The only way a message could "leak" across
 * workspaces is if an unauthorized socket were allowed to join the wrong
 * room in the first place, which is exactly what the join-time checks above
 * prevent.
 *
 * Trade-off worth knowing: if a user is removed from a channel (or their
 * workspace) mid-session, their already-connected socket keeps this room
 * membership until they rejoin/reconnect — there's no live-kick mechanism
 * for room membership today (contrast with kickUserSockets in registry.ts,
 * which forcibly disconnects a banned/suspended user entirely). Fine for the
 * current feature set; would need addressing if a "remove workspace member"
 * feature is ever added.
 */
export const isInChannelRoom = (socket: AuthenticatedSocket, channelId: string): boolean =>
  socket.rooms.has(channelId);

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
