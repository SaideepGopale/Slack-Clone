import { Socket } from 'socket.io';

export interface SocketUser {
  id: string;
  username: string;
}

export interface AuthenticatedSocket extends Socket {
  user: SocketUser;
}
