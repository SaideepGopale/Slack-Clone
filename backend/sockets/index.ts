import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { JWT_SECRET, NODE_ENV, APP_URL } from '../config/env';
import { prisma } from '../lib/prisma';
import { registerAdminHandlers } from './admin.handlers';
import { registerCallHandlers } from './calls.handlers';
import { registerChannelHandlers } from './channels.handlers';
import { registerMessageHandlers } from './messages.handlers';
import { registerPresenceHandlers } from './presence.handlers';
import { setSocketServer } from './registry';
import { AuthenticatedSocket } from './types';

export const createSocketServer = (httpServer: HttpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: NODE_ENV === 'production' ? APP_URL : '*',
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  setSocketServer(io);

  // Status is checked here (once per connection) rather than in the JWT
  // itself, since a still-valid 7-day token from before a ban/suspension
  // shouldn't keep working. This alone only stops *new* connections though —
  // an already-connected socket keeps working until it disconnects, which is
  // what kickUserSockets()/admin:user:kick (registry.ts, admin.handlers.ts)
  // exist to force immediately instead of waiting for a reconnect.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication Error'));
    jwt.verify(token, JWT_SECRET as string, async (err: any, decoded: any) => {
      if (err) return next(new Error('Invalid Token'));

      const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { status: true } });
      if (!user || user.status !== 'ACTIVE') return next(new Error('Account suspended'));

      (socket as AuthenticatedSocket).user = decoded;
      next();
    });
  });

  io.on('connection', (socket) => {
    const authSocket = socket as AuthenticatedSocket;
    // Lets kickUserSockets() target every session belonging to this user
    // (they may have multiple tabs/devices connected) without the server
    // needing to track socket IDs per user itself.
    authSocket.join(`user:${authSocket.user.id}`);
    registerPresenceHandlers(io, authSocket);
    registerChannelHandlers(io, authSocket);
    registerCallHandlers(io, authSocket);
    registerMessageHandlers(io, authSocket);
    registerAdminHandlers(io, authSocket);
  });

  return io;
};
