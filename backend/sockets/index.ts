import { createAdapter } from '@socket.io/redis-adapter';
import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { NODE_ENV, APP_URL } from '../config/env';
import { createAdapterClients } from '../lib/redis';
import { sessionRoom, verifySessionToken } from '../lib/sessions';
import { registerAdminHandlers } from './admin.handlers';
import { registerCallHandlers } from './calls.handlers';
import { registerChannelHandlers } from './channels.handlers';
import { subscribeToMemberChannels } from './channelAccess';
import { registerMessageHandlers } from './messages.handlers';
import { registerPresenceHandlers, startPresenceHeartbeat } from './presence.handlers';
import { installSocketRateLimit } from './rateLimit';
import { setSocketServer } from './registry';
import { AuthenticatedSocket } from './types';

let stopBackground: (() => void) | null = null;
/** Stops this module's timers (graceful shutdown). */
export const stopSocketBackground = () => {
  stopBackground?.();
  stopBackground = null;
};

export const createSocketServer = (httpServer: HttpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: NODE_ENV === 'production' ? APP_URL : '*',
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // T.33 — horizontal scaling. With REDIS_URL, rooms and broadcasts span every
  // instance (io.to(room), socketsJoin/Leave, disconnectSockets, fetchSockets
  // all go through the adapter). Without it, the default in-memory adapter:
  // correct for exactly one instance.
  const adapterClients = createAdapterClients();
  if (adapterClients) {
    io.adapter(createAdapter(adapterClients.pub, adapterClients.sub, { key: 'sc:socket.io', requestsTimeout: 3_000 }));
  }

  setSocketServer(io);
  stopBackground = startPresenceHeartbeat(io);

  // Status is checked here (once per connection) rather than in the JWT
  // itself, since a still-valid 7-day token from before a ban/suspension
  // shouldn't keep working. This alone only stops *new* connections though —
  // an already-connected socket keeps working until it disconnects, which is
  // what kickUserSockets()/admin:user:kick (registry.ts, admin.handlers.ts)
  // exist to force immediately instead of waiting for a reconnect.
  // T.32 (audit H1/M6): the same server-side session check as REST
  // `authenticate` (lib/sessions.ts) — a revoked, expired or ended session, or
  // an account that is no longer ACTIVE, cannot connect. A database failure
  // now refuses the connection instead of leaving the handshake hanging. The
  // socket's identity is the database's (fresh username/role), not the token's.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) return next(new Error('Authentication Error'));
    verifySessionToken(token).then(
      (result) => {
        if (!result.ok) return next(new Error(result.error));
        (socket as AuthenticatedSocket).user = result.user;
        // T.33: RemoteSocket (another instance's view of this socket) only
        // carries `data` — the identity other instances authorize against.
        socket.data.user = result.user;
        next();
      },
      (err) => {
        console.error('Socket authentication failed:', err instanceof Error ? err.message : err);
        next(new Error('Authentication unavailable. Please retry.'));
      }
    );
  });

  io.on('connection', (socket) => {
    const authSocket = socket as AuthenticatedSocket;
    // Post-authentication guard (the handshake above is unchanged): a
    // connection must identify a concrete user before any collaboration
    // handler is registered.
    if (typeof authSocket.user?.id !== 'string' || !authSocket.user.id) {
      socket.disconnect(true);
      return;
    }
    // Lets kickUserSockets() target every session belonging to this user
    // (they may have multiple tabs/devices connected). No handler ever
    // leaves this room again (see channels.handlers.ts).
    authSocket.join(`user:${authSocket.user.id}`);
    // T.32: lets logout disconnect exactly the sockets of the ended session.
    if (authSocket.user.sid) authSocket.join(sessionRoom(authSocket.user.sid));
    // T.32 (audit M5): per-user event budgets, checked before any handler.
    installSocketRateLimit(authSocket);
    registerPresenceHandlers(io, authSocket);
    registerChannelHandlers(io, authSocket);
    registerCallHandlers(io, authSocket);
    registerMessageHandlers(io, authSocket);
    registerAdminHandlers(io, authSocket);

    // Subscribe to every authorized channel room — on first connect and on
    // every reconnect — then tell the client it is safe to backfill.
    subscribeToMemberChannels(authSocket)
      .then((channelIds) => authSocket.emit('subscriptions:ready', { channelIds }))
      .catch((err) => console.error('Failed to subscribe socket to channels:', err));
  });

  return io;
};
