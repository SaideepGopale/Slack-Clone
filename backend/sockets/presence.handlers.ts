import { Server } from 'socket.io';
import { AuthenticatedSocket } from './types';

interface OnlineUser {
  id: string;
  username: string;
  status: string;
  emoji: string;
  sockets: Set<string>;
}

interface PublicOnlineUser {
  id: string;
  username: string;
  status: string;
  emoji: string;
}

// In-memory presence — fine for a single instance; needs a shared store
// (e.g. Redis) if this ever runs behind more than one Node process.
const onlineUsers = new Map<string, OnlineUser>();

const toPublic = ({ sockets: _sockets, ...user }: OnlineUser): PublicOnlineUser => user;

// Previously this broadcast the ENTIRE onlineUsers array to every connected
// client on every single connect/disconnect/status-change — O(n) payload
// times n recipients on every presence event, an O(n²) traffic pattern that
// dominates at 300+ concurrent users (normal churn like laptop sleep or wifi
// drops alone was enough to make this the bottleneck).
//
// Now: a newly-connected socket gets ONE full snapshot via `presence:init`
// (unicast — just to that socket, since only it needs to bootstrap state).
// Everyone else only ever receives a single-user delta via `user:online`
// (new/changed) or `user:offline` (fully disconnected) — O(1) payload size,
// broadcast to n clients, not O(n) payload to n clients.
export const registerPresenceHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const user = socket.user;
  if (!user?.id) return;

  const existing = onlineUsers.get(user.id);
  let presence: OnlineUser;
  if (existing) {
    existing.sockets.add(socket.id);
    presence = existing;
  } else {
    presence = { id: user.id, username: user.username, status: 'active', emoji: '🟢', sockets: new Set([socket.id]) };
    onlineUsers.set(user.id, presence);
  }

  // Unicast — only the socket that just connected gets the full list.
  socket.emit('presence:init', { users: Array.from(onlineUsers.values()).map(toPublic) });

  // A second tab/device for an already-online user doesn't change what
  // anyone else sees, so only broadcast when this is a genuinely new user.
  if (!existing) {
    io.emit('user:online', toPublic(presence));
    // Admin dashboard's live "online now" counter — only meaningful to emit
    // when onlineUsers.size actually changed, same reasoning as above.
    io.emit('admin:stats:onlineCount', onlineUsers.size);
  }

  socket.on('user:status', (data: { status: string; emoji: string }) => {
    const current = onlineUsers.get(user.id);
    if (!current) return;
    current.status = data.status;
    current.emoji = data.emoji;
    io.emit('user:online', toPublic(current));
  });

  socket.on('disconnect', () => {
    const current = onlineUsers.get(user.id);
    if (!current) return;

    current.sockets.delete(socket.id);
    if (current.sockets.size === 0) {
      onlineUsers.delete(user.id);
      io.emit('user:offline', { id: user.id });
      io.emit('admin:stats:onlineCount', onlineUsers.size);
    }
  });
};
