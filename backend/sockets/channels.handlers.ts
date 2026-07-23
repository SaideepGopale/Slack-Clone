import { Server } from 'socket.io';
import { prisma } from '../lib/prisma';
import { isChannelMember, rejectUnauthorized } from './channelAccess';
import { AuthenticatedSocket } from './types';

export const registerChannelHandlers = (_io: Server, socket: AuthenticatedSocket) => {
  socket.on('channel:join', async (chanId: string) => {
    if (!chanId) return;

    try {
      // Room names are just the raw channel id (a globally unique UUID), so
      // Workspace A's "General" and Workspace B's "General" are already
      // different rooms with no way to collide — the only real risk is
      // authorization, not room-naming. Two checks, not one, close that:
      //
      // 1. isChannelMember: is this user a member of this specific channel?
      // 2. workspace membership: is that membership still backed by real
      //    tenant access? A ChannelMember row can outlive someone's actual
      //    membership in the Workspace that owns the channel (there's no
      //    "remove workspace member" cleanup cascade today) — without this
      //    second check, a stale ChannelMember row would let a former tenant
      //    member keep listening to that workspace's channel forever.
      const channel = await prisma.channel.findUnique({ where: { id: chanId }, select: { workspaceId: true } });
      if (!channel) {
        rejectUnauthorized(socket, { event: 'channel:join', channelId: chanId, message: 'Channel not found.' });
        return;
      }

      const [member, isWorkspaceMember] = await Promise.all([
        isChannelMember(socket.user.id, chanId),
        prisma.workspaceMember
          .findUnique({ where: { userId_workspaceId: { userId: socket.user.id, workspaceId: channel.workspaceId } } })
          .then(Boolean),
      ]);

      if (!member || !isWorkspaceMember) {
        rejectUnauthorized(socket, { event: 'channel:join', channelId: chanId });
        return;
      }

      socket.rooms.forEach((r) => {
        if (r !== socket.id) socket.leave(r);
      });
      socket.join(chanId);
    } catch (err) {
      // This is the single most frequently fired event in the app (fires on
      // every channel switch) — without this catch, a transient DB error
      // here becomes an unhandled rejection inside a Socket.IO listener,
      // which Socket.IO does not catch on its own the way Express catches
      // synchronous throws.
      console.error('channel:join failed:', err);
    }
  });
};
