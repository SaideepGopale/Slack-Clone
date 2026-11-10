import { prisma } from '../lib/prisma';
import { removeFromCallRoom } from './calls.handlers';
import { getSocketServer } from './registry';
import { AuthenticatedSocket } from './types';

/**
 * Immediate real-time access revocation (Batch 2, requirement 6).
 *
 * REST access is already revoked by the database the moment a membership row
 * disappears (every protected route re-checks membership per request). Live
 * sockets, however, hold room subscriptions; this removes a user's sockets
 * from:
 *  - the channel rooms (no further message/typing/reaction/receipt events),
 *  - thread rooms whose parent message belongs to those channels,
 *  - call rooms for those channels (peers are told the participant left).
 *
 * Single-process assumption (matches the rest of the socket layer): reads the
 * local adapter's room registry. A multi-instance deployment needs the Redis
 * adapter's `fetchSockets()` / `socketsLeave()` equivalents (Batch 9).
 */

const localUserSockets = (userId: string): AuthenticatedSocket[] => {
  const io = getSocketServer();
  const ids = io?.sockets.adapter.rooms.get(`user:${userId}`);
  if (!io || !ids) return [];
  return Array.from(ids)
    .map((id) => io.sockets.sockets.get(id) as AuthenticatedSocket | undefined)
    .filter((s): s is AuthenticatedSocket => !!s);
};

export const revokeChannelAccess = async (userId: string, channelIds: string[]): Promise<void> => {
  if (channelIds.length === 0) return;
  const sockets = localUserSockets(userId);
  if (sockets.length === 0) return;

  const threadRooms = new Set<string>();
  for (const socket of sockets) {
    for (const room of socket.rooms) if (room.startsWith('thread_')) threadRooms.add(room);
  }
  let revokedThreadRooms = new Set<string>();
  if (threadRooms.size > 0) {
    const parents = await prisma.message.findMany({
      where: { id: { in: Array.from(threadRooms).map((r) => r.slice('thread_'.length)) }, channelId: { in: channelIds } },
      select: { id: true },
    });
    revokedThreadRooms = new Set(parents.map((p) => `thread_${p.id}`));
  }

  for (const socket of sockets) {
    for (const channelId of channelIds) {
      socket.leave(channelId);
      removeFromCallRoom(socket, channelId);
    }
    for (const room of revokedThreadRooms) socket.leave(room);
  }
};
