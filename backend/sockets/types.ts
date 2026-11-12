import { Socket } from 'socket.io';

export interface SocketUser {
  id: string;
  username: string;
  // T.32: from the database at handshake time (lib/sessions.ts), plus the
  // server-side session the connection was opened with.
  role?: string;
  sid?: string;
}

export interface AuthenticatedSocket extends Socket {
  user: SocketUser;
}
