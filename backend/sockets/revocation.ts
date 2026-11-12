import { prisma } from '../lib/prisma';
import { removeUserFromCalls } from './calls.handlers';
import { getSocketServer } from './registry';

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
 * T.33: works across instances — `fetchSockets()` returns the user's sockets
 * on every instance (through the Redis adapter when configured), and leaving
 * a room / dropping from a call goes through the adapter and the shared call
 * store.
 */
export const revokeChannelAccess = async (userId: string, channelIds: string[]): Promise<void> => {
  if (channelIds.length === 0) return;
  const io = getSocketServer();
  if (!io) return;

  // Calls first: the call store knows every participant, even one whose
  // socket is on an instance that is slow to answer fetchSockets.
  await removeUserFromCalls(io, userId, channelIds);

  const sockets = await io.in(`user:${userId}`).fetchSockets();
  if (sockets.length === 0) return;

  const threadRooms = new Set<string>();
  for (const socket of sockets) {
    for (const room of socket.rooms) if (room.startsWith('thread_')) threadRooms.add(room);
  }
  let revokedThreadRooms: string[] = [];
  if (threadRooms.size > 0) {
    const parents = await prisma.message.findMany({
      where: { id: { in: Array.from(threadRooms).map((r) => r.slice('thread_'.length)) }, channelId: { in: channelIds } },
      select: { id: true },
    });
    revokedThreadRooms = parents.map((p) => `thread_${p.id}`);
  }

  io.in(`user:${userId}`).socketsLeave([...channelIds, ...revokedThreadRooms]);
};
