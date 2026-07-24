import { Server } from 'socket.io';
import { isAdminUser } from '../middleware/admin.middleware';
import { prisma } from '../lib/prisma';
import { logAuditEvent } from '../lib/auditLog';
import { kickUserSockets } from './registry';
import { AuthenticatedSocket } from './types';

// These previously had no server-side admin check at all — any authenticated
// socket could create/delete channels for the whole workspace. Gated with the
// same isAdminUser() check the REST admin routes use, now that this is its
// own module instead of being buried in the monolithic connection handler.
// The app is now a single-"General"-channel workspace (seeded once via
// reset-to-general-channel.ts) — there's no `admin:channel:created` handler
// anymore, matching the REST API where POST /api/channels was also removed.
// Deletion and listing remain: an admin can still remove a stray channel or
// refresh the list, just not create new ones.
export const registerAdminHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const user = socket.user;

  socket.on('admin:channel:deleted', async (channelId: string) => {
    try {
      if (!(await isAdminUser(user.id))) {
        socket.emit('error', 'Admin access required');
        return;
      }

      // Was comparing the channel's UUID against the literal string
      // "general" — that can never match, so this never actually protected
      // the General channel from deletion via this socket path (only the
      // REST route's equivalent check, which correctly reads channel.name,
      // did). Fixed by fetching the channel first and checking its real name.
      const channel = await prisma.channel.findUnique({ where: { id: channelId } });
      if (!channel) {
        socket.emit('error', 'Channel not found');
        return;
      }
      if (channel.name && channel.name.toLowerCase() === 'general') {
        socket.emit('error', 'Cannot delete general channel');
        return;
      }

      await prisma.channel.delete({ where: { id: channelId } });
      await logAuditEvent(user.id, 'DELETE_CHANNEL', 'CHANNEL', channelId, `Deleted channel "#${channel.name ?? channelId}"`);
      io.emit('admin:channel:list:updated', { action: 'deleted', channelId });
    } catch (err) {
      console.error('Failed to delete channel:', err);
      socket.emit('error', 'Failed to delete channel');
    }
  });

  // Manual real-time enforcement: an admin can force-disconnect a currently
  // banned/suspended user's active session right now, rather than relying on
  // the connection-time check to catch them at their next reconnect. (The
  // REST status-update route also calls kickUserSockets automatically — see
  // admin.service.ts — this event exists for the admin panel to trigger the
  // same thing on demand, e.g. a "Kick now" button.)
  socket.on('admin:user:kick', async (targetUserId: string) => {
    try {
      if (!(await isAdminUser(user.id))) {
        socket.emit('error', 'Admin access required');
        return;
      }

      const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { status: true } });
      if (!target) {
        socket.emit('error', 'User not found');
        return;
      }
      if (target.status === 'ACTIVE') {
        socket.emit('error', 'User is not suspended or banned');
        return;
      }

      kickUserSockets(targetUserId);
      socket.emit('admin:user:kicked', { userId: targetUserId });
    } catch (err) {
      console.error('Failed to kick user:', err);
      socket.emit('error', 'Failed to kick user');
    }
  });

  socket.on('admin:refresh:channels', async () => {
    try {
      if (!(await isAdminUser(user.id))) {
        socket.emit('error', 'Admin access required');
        return;
      }

      const channels = await prisma.channel.findMany({
        where: { isDM: false },
        include: { members: { include: { user: { select: { id: true, username: true } } } } },
      });
      socket.emit('admin:channels:list', channels);
    } catch (err) {
      console.error('Failed to refresh channels:', err);
    }
  });
};
