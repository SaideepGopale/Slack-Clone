import { Server } from 'socket.io';
import { ensureChannelAccess, rejectUnauthorized } from './channelAccess';
import { toAck } from './ack';
import { AuthenticatedSocket } from './types';

export const registerChannelHandlers = (_io: Server, socket: AuthenticatedSocket) => {
  // Explicit subscription request — idempotent. Sockets are already
  // subscribed to every authorized channel on connect (see
  // subscribeToMemberChannels), so this mainly covers a channel the user
  // gained access to in another tab or device.
  //
  // Unlike the previous implementation this NEVER leaves other rooms: the old
  // "leave everything except my socket id" step also left the personal
  // `user:<id>` room plus call/thread rooms (audit RT-01).
  socket.on('channel:join', async (channelId: unknown, maybeAck?: unknown) => {
    const ack = toAck(maybeAck);
    try {
      if (await ensureChannelAccess(socket, channelId)) {
        ack({ ok: true });
        return;
      }
      rejectUnauthorized(socket, { event: 'channel:join', channelId: String(channelId ?? '') });
      ack({ ok: false, error: 'You are not a member of this channel.' });
    } catch (err) {
      console.error('channel:join failed:', err);
      ack({ ok: false, error: 'Could not join channel.' });
    }
  });
};
