import { createServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as connectClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P2 Phase H — call lifecycle: ringing can be declined, cancelled, times out,
 * and archived conversations cannot host calls. Database-free, same harness
 * shape as call-signalling.test.ts (real Socket.IO server and clients,
 * in-memory membership behind mocked prisma / isChannelMember).
 */
const world = vi.hoisted(() => ({
  channels: new Map<string, { workspaceId: string; isDM?: boolean; isGroupDM?: boolean; archivedAt?: Date | null }>(),
  channelMembers: new Set<string>(),
  workspaceMembers: new Set<string>(),
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    channel: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const c = world.channels.get(where.id);
        return c ? { workspaceId: c.workspaceId, isDM: !!c.isDM, isGroupDM: !!c.isGroupDM, archivedAt: c.archivedAt ?? null } : null;
      },
    },
    workspaceMember: {
      findUnique: async ({ where }: { where: { userId_workspaceId: { userId: string; workspaceId: string } } }) =>
        world.workspaceMembers.has(`${where.userId_workspaceId.userId}|${where.userId_workspaceId.workspaceId}`) ? { id: 'wm' } : null,
    },
    $disconnect: async () => undefined,
  },
}));
vi.mock('../sockets/channelAccess', () => ({
  isChannelMember: async (userId: string, channelId: string) => world.channelMembers.has(`${userId}|${channelId}`),
}));

import { registerCallHandlers } from '../sockets/calls.handlers';
import type { AuthenticatedSocket } from '../sockets/types';

const WS = 'workspace-a';
const CH = '11111111-1111-4111-8111-111111111111'; // channel: alice, bob, carol
const DM = '33333333-3333-4333-8333-333333333333'; // 1:1 DM: alice, bob
const ARCHIVED = '44444444-4444-4444-8444-444444444444'; // archived channel: alice, bob

let io: Server;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  const http = createServer();
  io = new Server(http);
  io.use((socket, next) => {
    const { userId } = socket.handshake.auth as { userId: string };
    (socket as AuthenticatedSocket).user = { id: userId, username: `${userId}-name` };
    next();
  });
  io.on('connection', (raw) => {
    const socket = raw as AuthenticatedSocket;
    socket.join(`user:${socket.user.id}`);
    for (const channelId of world.channels.keys()) {
      if (world.channelMembers.has(`${socket.user.id}|${channelId}`)) socket.join(channelId);
    }
    registerCallHandlers(io, socket);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

beforeEach(() => {
  delete process.env.CALL_RING_TIMEOUT_MS;
  world.channels.clear();
  world.channelMembers.clear();
  world.workspaceMembers.clear();
  world.channels.set(CH, { workspaceId: WS });
  world.channels.set(DM, { workspaceId: WS, isDM: true });
  world.channels.set(ARCHIVED, { workspaceId: WS, archivedAt: new Date() });
  for (const user of ['alice', 'bob', 'carol']) {
    world.workspaceMembers.add(`${user}|${WS}`);
    world.channelMembers.add(`${user}|${CH}`);
  }
  for (const user of ['alice', 'bob']) {
    world.channelMembers.add(`${user}|${DM}`);
    world.channelMembers.add(`${user}|${ARCHIVED}`);
  }
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

const connect = (userId: string) =>
  new Promise<ClientSocket>((resolve, reject) => {
    const client = connectClient(url, { auth: { userId }, transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(client);
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });

const next = <T = unknown>(client: ClientSocket, event: string, ms = 600) =>
  new Promise<T | undefined>((resolve) => {
    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      client.off(event, onEvent);
      resolve(undefined);
    }, ms);
    client.once(event, onEvent);
  });

/** Alice rings `channelId`; resolves once bob has seen the ring. */
const ring = async (alice: ClientSocket, bob: ClientSocket, channelId = CH) => {
  const incoming = next(bob, 'call:incoming', 2000);
  alice.emit('call:initiate', { channelId, callType: 'audio' });
  expect(await incoming).toMatchObject({ channelId, from: 'alice' });
};

describe('call lifecycle (P2 Phase H)', () => {
  it("P3: never rings the caller's own other tabs or devices", async () => {
    const alice = await connect('alice');
    const aliceSecondTab = await connect('alice');
    const bob = await connect('bob');
    const selfRing = next(aliceSecondTab, 'call:incoming');
    await ring(alice, bob);
    expect(await selfRing).toBeUndefined();
  });

  it('refuses to ring or join a call in an archived conversation', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const error = next<{ message: string }>(alice, 'webrtc:error');
    const incoming = next(bob, 'call:incoming');
    alice.emit('call:initiate', { channelId: ARCHIVED, callType: 'video' });
    expect(await error).toBeDefined();
    expect(await incoming).toBeUndefined();

    const joinError = next(bob, 'webrtc:error');
    const joined = next(bob, 'webrtc:existing-participants');
    bob.emit('webrtc:join', { channelId: ARCHIVED });
    expect(await joinError).toBeDefined();
    expect(await joined).toBeUndefined();
  });

  it('tells only the caller when someone declines', async () => {
    const [alice, bob, carol] = await Promise.all([connect('alice'), connect('bob'), connect('carol')]);
    await ring(alice, bob);
    const atAlice = next(alice, 'call:declined');
    const atCarol = next(carol, 'call:declined');
    bob.emit('call:decline', { channelId: CH });
    expect(await atAlice).toEqual({ channelId: CH, userId: 'bob', username: 'bob-name' });
    expect(await atCarol).toBeUndefined();
  });

  it('ignores declines without a ring, from outsiders, or from the caller', async () => {
    const [alice, bob] = await Promise.all([connect('alice'), connect('bob')]);
    const mallory = await connect('mallory');

    const noRing = next(alice, 'call:declined');
    bob.emit('call:decline', { channelId: CH });
    expect(await noRing).toBeUndefined();

    await ring(alice, bob);
    const fromOutsider = next(alice, 'call:declined');
    mallory.emit('call:decline', { channelId: CH });
    expect(await fromOutsider).toBeUndefined();

    const fromSelf = next(alice, 'call:declined');
    alice.emit('call:decline', { channelId: CH });
    expect(await fromSelf).toBeUndefined();
  });

  it('lets only the caller cancel a ring, which dismisses it for everyone', async () => {
    const [alice, bob, carol] = await Promise.all([connect('alice'), connect('bob'), connect('carol')]);
    await ring(alice, bob);

    const notByBob = next(carol, 'call:ring_ended');
    bob.emit('call:cancel', { channelId: CH });
    expect(await notByBob).toBeUndefined();

    const atBob = next(bob, 'call:ring_ended');
    const atCarol = next(carol, 'call:ring_ended');
    alice.emit('call:cancel', { channelId: CH });
    expect(await atBob).toEqual({ channelId: CH, reason: 'cancelled' });
    expect(await atCarol).toEqual({ channelId: CH, reason: 'cancelled' });
  });

  it('ends an unanswered ring after the timeout', async () => {
    process.env.CALL_RING_TIMEOUT_MS = '1000';
    const [alice, bob] = await Promise.all([connect('alice'), connect('bob')]);
    await ring(alice, bob);
    const ended = next(bob, 'call:ring_ended', 3000);
    const atCaller = next(alice, 'call:ring_ended', 3000);
    expect(await ended).toEqual({ channelId: CH, reason: 'timeout' });
    expect(await atCaller).toEqual({ channelId: CH, reason: 'timeout' });
  });

  it('cancels the ring when the caller disconnects', async () => {
    const [alice, bob] = await Promise.all([connect('alice'), connect('bob')]);
    await ring(alice, bob);
    const ended = next(bob, 'call:ring_ended', 2000);
    alice.disconnect();
    expect(await ended).toEqual({ channelId: CH, reason: 'cancelled' });
  });

  it('in a 1:1 DM, declining or answering ends the ring for every device', async () => {
    const [alice, bob] = await Promise.all([connect('alice'), connect('bob')]);
    const bobPhone = await connect('bob');

    await ring(alice, bob, DM);
    const declinedOnPhone = next(bobPhone, 'call:ring_ended');
    bob.emit('call:decline', { channelId: DM });
    expect(await declinedOnPhone).toEqual({ channelId: DM, reason: 'declined' });

    await ring(alice, bob, DM);
    const answeredOnPhone = next(bobPhone, 'call:ring_ended', 2000);
    alice.emit('webrtc:join', { channelId: DM });
    await next(alice, 'webrtc:existing-participants', 2000);
    bob.emit('webrtc:join', { channelId: DM });
    expect(await answeredOnPhone).toEqual({ channelId: DM, reason: 'answered' });
  });
});
