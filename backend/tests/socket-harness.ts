import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as ioClient, Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { app } from '../app';
import { createSocketServer } from '../sockets';
import { TestUser } from './collab-helpers';

/**
 * Real HTTP + Socket.IO server on an ephemeral port, shared by a test file.
 * Call `useSocketHarness()` at module scope; it registers the lifecycle hooks.
 */
export const useSocketHarness = () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let baseUrl = '';
  const open: Socket[] = [];

  beforeAll(async () => {
    httpServer = createServer(app);
    ioServer = createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    for (const s of open) s.disconnect();
    open.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  });

  /** Connects and resolves once the server has subscribed channels AND sent presence. */
  const connect = (user: TestUser) =>
    new Promise<{ socket: Socket; channelIds: string[]; presence: { id: string }[] }>((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { token: user.token },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      open.push(socket);
      let channelIds: string[] | null = null;
      let presence: { id: string }[] | null = null;
      const done = () => {
        if (channelIds && presence) {
          clearTimeout(timer);
          resolve({ socket, channelIds, presence });
        }
      };
      const timer = setTimeout(() => reject(new Error('socket did not become ready')), 5000);
      socket.once('subscriptions:ready', (p: { channelIds: string[] }) => {
        channelIds = p.channelIds;
        done();
      });
      socket.once('presence:init', (p: { users: { id: string }[] }) => {
        presence = p.users;
        done();
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  return { connect };
};

export interface AckResult {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
  message?: Record<string, unknown> & { id: string };
}

export const emitAck = (socket: Socket, event: string, payload: unknown): Promise<AckResult> =>
  new Promise((resolve) => {
    socket.timeout(5000).emit(event, payload, (err: Error | null, res: AckResult) =>
      resolve(err ? { ok: false, error: 'ack timeout' } : res)
    );
  });

export const nextEvent = <T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 3000
): Promise<T> =>
  new Promise((resolve, reject) => {
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    socket.on(event, handler);
  });

export const collect = async <T = Record<string, unknown>>(socket: Socket, event: string, ms: number): Promise<T[]> => {
  const seen: T[] = [];
  const handler = (payload: T) => seen.push(payload);
  socket.on(event, handler);
  await new Promise((r) => setTimeout(r, ms));
  socket.off(event, handler);
  return seen;
};
