import { createServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as connectClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-A — FA-RT-01: authorization of the WebRTC signaling relay
 * (backend/sockets/calls.handlers.ts).
 *
 * Database-free: membership (channel → workspace, channel members, workspace
 * members) is an in-memory fixture behind mocked `prisma` / `isChannelMember`.
 * A real Socket.IO server and real clients are used, with the production room
 * layout (`user:<id>`, `ws:<workspaceId>`, channel rooms, `call:<channelId>`),
 * so the old `io.to(data.to)` relay would deliver the attacks below.
 */
const world = vi.hoisted(() => ({
  channels: new Map<string, string>(), // channelId -> workspaceId
  channelMembers: new Set<string>(), // `${userId}|${channelId}`
  workspaceMembers: new Set<string>(), // `${userId}|${workspaceId}`
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    channel: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        world.channels.has(where.id) ? { workspaceId: world.channels.get(where.id) } : null,
    },
    workspaceMember: {
      findUnique: async ({ where }: { where: { userId_workspaceId: { userId: string; workspaceId: string } } }) =>
        world.workspaceMembers.has(`${where.userId_workspaceId.userId}|${where.userId_workspaceId.workspaceId}`) ? { id: 'wm' } : null,
    },
    $disconnect: async () => undefined, // tests/setup.ts disconnects prisma after each file
  },
}));
vi.mock('../sockets/channelAccess', () => ({
  isChannelMember: async (userId: string, channelId: string) => world.channelMembers.has(`${userId}|${channelId}`),
}));

import { registerCallHandlers } from '../sockets/calls.handlers';
import type { AuthenticatedSocket } from '../sockets/types';

const WS_A = 'workspace-a';
const WS_M = 'workspace-m';
const CH_A = '11111111-1111-4111-8111-111111111111'; // channel in workspace A (alice, bob, carol)
const CH_M = '22222222-2222-4222-8222-222222222222'; // the attacker's own channel in workspace M

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\n' };
const CANDIDATE = { candidate: 'candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };

let io: Server;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  const http = createServer();
  io = new Server(http);
  io.use((socket, next) => {
    // Stands in for the JWT handshake: the authenticated identity is whatever
    // the (trusted) test harness says, never anything sent in event payloads.
    const { userId, username } = socket.handshake.auth as { userId: string; username?: string };
    (socket as AuthenticatedSocket).user = { id: userId, username: username ?? userId };
    next();
  });
  io.on('connection', (raw) => {
    const socket = raw as AuthenticatedSocket;
    const userId = socket.user.id;
    // Production room layout: personal room, workspace rooms, channel rooms.
    socket.join(`user:${userId}`);
    for (const [channelId, workspaceId] of world.channels) {
      if (world.workspaceMembers.has(`${userId}|${workspaceId}`)) socket.join(`ws:${workspaceId}`);
      if (world.channelMembers.has(`${userId}|${channelId}`)) socket.join(channelId);
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
  world.channels.clear();
  world.channelMembers.clear();
  world.workspaceMembers.clear();
  world.channels.set(CH_A, WS_A);
  world.channels.set(CH_M, WS_M);
  for (const user of ['alice', 'bob', 'carol']) {
    world.workspaceMembers.add(`${user}|${WS_A}`);
    world.channelMembers.add(`${user}|${CH_A}`);
  }
  world.workspaceMembers.add(`mallory|${WS_M}`);
  world.channelMembers.add(`mallory|${CH_M}`);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the server's disconnect cleanup run
});

const connect = (userId: string, username?: string) =>
  new Promise<ClientSocket>((resolve, reject) => {
    const client = connectClient(url, { auth: { userId, username }, transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(client);
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });

/** Resolves with the next payload of `event`, or `undefined` if none arrives within `ms`. */
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

const joinCall = async (client: ClientSocket, channelId: string) => {
  const existing = next<{ participants: { socketId: string }[] }>(client, 'webrtc:existing-participants', 2000);
  client.emit('webrtc:join', { channelId });
  const result = await existing;
  expect(result, 'joined the call').toBeDefined();
  return result!;
};

/** Alice and Bob in a legitimate call in channel A. */
const legitimateCall = async () => {
  const alice = await connect('alice');
  const bob = await connect('bob');
  await joinCall(alice, CH_A);
  const bobAnnounced = next(alice, 'webrtc:peer-joined', 2000);
  const { participants } = await joinCall(bob, CH_A);
  expect(participants.map((p) => p.socketId)).toEqual([alice.id]);
  expect(await bobAnnounced).toMatchObject({ socketId: bob.id, userId: 'bob' });
  return { alice, bob };
};

describe('WebRTC signaling relay authorization (FA-RT-01)', () => {
  it('still relays offer, answer and ICE between participants of the same call, tagged with the call id', async () => {
    const { alice, bob } = await legitimateCall();

    const offerAtAlice = next(alice, 'webrtc:offer');
    bob.emit('webrtc:offer', { channelId: CH_A, to: alice.id, offer: OFFER });
    expect(await offerAtAlice).toEqual({ from: bob.id, channelId: CH_A, offer: OFFER });

    const answerAtBob = next(bob, 'webrtc:answer');
    alice.emit('webrtc:answer', { channelId: CH_A, to: bob.id, answer: ANSWER });
    expect(await answerAtBob).toEqual({ from: alice.id, channelId: CH_A, answer: ANSWER });

    const iceAtAlice = next(alice, 'webrtc:ice-candidate');
    bob.emit('webrtc:ice-candidate', { channelId: CH_A, to: alice.id, candidate: CANDIDATE });
    expect(await iceAtAlice).toEqual({ from: bob.id, channelId: CH_A, candidate: CANDIDATE });
  });

  it('rejects cross-workspace targeting: an attacker in their own call reaches nobody by room name or socket id', async () => {
    const { alice, bob } = await legitimateCall();
    const mallory = await connect('mallory');
    await joinCall(mallory, CH_M); // a call she IS authorized for, in her own workspace

    const received = [
      next(alice, 'webrtc:offer'),
      next(bob, 'webrtc:offer'),
      next(alice, 'webrtc:ice-candidate'),
      next(bob, 'webrtc:ice-candidate'),
      next(alice, 'webrtc:answer'),
    ];
    for (const to of ['user:alice', 'user:bob', `ws:${WS_A}`, CH_A, `call:${CH_A}`, alice.id, bob.id]) {
      mallory.emit('webrtc:offer', { channelId: CH_M, to, offer: OFFER });
      mallory.emit('webrtc:answer', { channelId: CH_M, to, answer: ANSWER });
      mallory.emit('webrtc:ice-candidate', { channelId: CH_M, to, candidate: CANDIDATE });
      // Claiming the victims' call doesn't help either: she is not a participant of it.
      mallory.emit('webrtc:offer', { channelId: CH_A, to, offer: OFFER });
    }
    expect(await Promise.all(received)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('channel members who are not in the call receive no call signaling', async () => {
    const { alice } = await legitimateCall();
    const carol = await connect('carol'); // channel + workspace member who never joined the call

    const received = [next(carol, 'webrtc:offer'), next(carol, 'webrtc:ice-candidate')];
    for (const to of [carol.id, 'user:carol', CH_A, `ws:${WS_A}`]) {
      alice.emit('webrtc:offer', { channelId: CH_A, to, offer: OFFER });
      alice.emit('webrtc:ice-candidate', { channelId: CH_A, to, candidate: CANDIDATE });
    }
    expect(await Promise.all(received)).toEqual([undefined, undefined]);
  });

  it('ignores signaling from an authorized member who has not joined the call', async () => {
    const { alice } = await legitimateCall();
    const carol = await connect('carol');
    const offerAtAlice = next(alice, 'webrtc:offer');
    carol.emit('webrtc:offer', { channelId: CH_A, to: alice.id, offer: OFFER });
    expect(await offerAtAlice).toBeUndefined();
  });

  it('re-authorizes the recipient: a participant who lost channel access is evicted instead of receiving', async () => {
    const { alice, bob } = await legitimateCall();
    world.channelMembers.delete(`bob|${CH_A}`); // removed from the channel mid-call

    const offerAtBob = next(bob, 'webrtc:offer');
    const bobLeft = next<{ socketId: string }>(alice, 'webrtc:peer-left', 2000);
    alice.emit('webrtc:offer', { channelId: CH_A, to: bob.id, offer: OFFER });
    expect(await offerAtBob).toBeUndefined();
    expect(await bobLeft).toEqual({ socketId: bob.id });

    const iceAtBob = next(bob, 'webrtc:ice-candidate');
    alice.emit('webrtc:ice-candidate', { channelId: CH_A, to: bob.id, candidate: CANDIDATE });
    expect(await iceAtBob).toBeUndefined();
  });

  it('re-authorizes the sender: a participant removed from the workspace is evicted and nothing is relayed', async () => {
    const { alice, bob } = await legitimateCall();
    world.workspaceMembers.delete(`bob|${WS_A}`);

    const offerAtAlice = next(alice, 'webrtc:offer');
    const bobLeft = next<{ socketId: string }>(alice, 'webrtc:peer-left', 2000);
    bob.emit('webrtc:offer', { channelId: CH_A, to: alice.id, offer: OFFER });
    expect(await offerAtAlice).toBeUndefined();
    expect(await bobLeft).toEqual({ socketId: bob.id });
  });

  it('drops malformed or oversized payloads and forwards only the signaling fields', async () => {
    const { alice, bob } = await legitimateCall();

    const noOffer = next(alice, 'webrtc:offer');
    bob.emit('webrtc:offer', { channelId: CH_A, to: alice.id, offer: { type: 'offer', sdp: 'x'.repeat(100_001) } });
    bob.emit('webrtc:offer', { channelId: CH_A, to: alice.id, offer: { type: 'answer', sdp: OFFER.sdp } });
    bob.emit('webrtc:offer', { channelId: CH_A, to: alice.id, offer: 'not-an-object' });
    bob.emit('webrtc:offer', { channelId: CH_A, to: bob.id, offer: OFFER }); // to itself
    bob.emit('webrtc:offer', { channelId: { $ne: null }, to: alice.id, offer: OFFER });
    expect(await noOffer).toBeUndefined();

    const noIce = next(alice, 'webrtc:ice-candidate');
    bob.emit('webrtc:ice-candidate', { channelId: CH_A, to: alice.id, candidate: { candidate: 'x'.repeat(4_097) } });
    bob.emit('webrtc:ice-candidate', { channelId: CH_A, to: alice.id, candidate: { candidate: 'c', sdpMLineIndex: -1 } });
    bob.emit('webrtc:ice-candidate', { channelId: CH_A, to: alice.id, candidate: 42 });
    expect(await noIce).toBeUndefined();

    const sanitizedOffer = next(alice, 'webrtc:offer');
    bob.emit('webrtc:offer', { channelId: CH_A, to: alice.id, offer: { ...OFFER, junk: 'x'.repeat(50_000) }, extra: { a: 1 } });
    expect(await sanitizedOffer).toEqual({ from: bob.id, channelId: CH_A, offer: OFFER });

    const sanitizedIce = next(alice, 'webrtc:ice-candidate');
    bob.emit('webrtc:ice-candidate', { channelId: CH_A, to: alice.id, candidate: { ...CANDIDATE, junk: 1 } });
    expect(await sanitizedIce).toEqual({ from: bob.id, channelId: CH_A, candidate: CANDIDATE });
  });
});

/**
 * P1-B — FA-RT-02: `call:initiate` (the "ring the channel" request behind the
 * incoming-call banner). Same DB-free world as above.
 */
type Ring = { channelId: string; callerName: string; callType: string; from: string };

/** Every payload of `event` that `client` receives within `ms`. */
const collect = <T = unknown>(client: ClientSocket, event: string, ms = 700) =>
  new Promise<T[]>((resolve) => {
    const seen: T[] = [];
    const onEvent = (payload: T) => seen.push(payload);
    client.on(event, onEvent);
    setTimeout(() => {
      client.off(event, onEvent);
      resolve(seen);
    }, ms);
  });

const INVALID = { message: 'Invalid call request.' };
const NOT_AUTHORIZED = { message: 'You are not authorized to start a call in this channel.' };

/** Sends every payload as `caller`; returns the errors the caller got and the rings `listener` got. */
const ringAll = async (caller: ClientSocket, listener: ClientSocket, payloads: unknown[]) => {
  const errors = collect<{ message: string }>(caller, 'webrtc:error');
  const rings = collect<Ring>(listener, 'call:incoming');
  for (const payload of payloads) caller.emit('call:initiate', payload);
  return { errors: await errors, rings: await rings };
};

describe('Incoming-call ring validation (FA-RT-02)', () => {
  it('valid incoming call: rings the other channel members with the server-derived caller identity', async () => {
    const [alice, bob, carol, mallory] = [await connect('alice'), await connect('bob'), await connect('carol'), await connect('mallory')];
    const [atCarol, atMallory, atAlice] = [collect<Ring>(carol, 'call:incoming'), collect(mallory, 'call:incoming'), collect(alice, 'call:incoming')];

    // What the fixed client sends: no caller name at all ("missing caller name").
    const { errors, rings } = await ringAll(alice, bob, [{ channelId: CH_A, callType: 'video' }]);

    const expected = { channelId: CH_A, callerName: 'alice', callType: 'video', from: 'alice' };
    expect(errors).toEqual([]);
    expect(rings).toEqual([expected]);
    expect(await atCarol).toEqual([expected]);
    expect(await atMallory).toEqual([]); // not a member of channel A
    expect(await atAlice).toEqual([]); // the caller is not rung
  });

  it('still rings for clients that send their own (authenticated) username as callerName', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const { errors, rings } = await ringAll(alice, bob, [{ channelId: CH_A, callerName: 'alice', callType: 'audio' }]);
    expect(errors).toEqual([]);
    expect(rings).toEqual([{ channelId: CH_A, callerName: 'alice', callType: 'audio', from: 'alice' }]);
  });

  it('spoofed caller identity: another name, or a client-supplied from/userId, is refused', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const payloads = [
      { channelId: CH_A, callType: 'audio', callerName: 'carol' }, // another member's name
      { channelId: CH_A, callType: 'audio', callerName: 'IT Support (Admin)' },
      { channelId: CH_A, callType: 'audio', callerName: 'alice ' }, // near-miss of her real name
      { channelId: CH_A, callType: 'audio', from: 'carol' },
      { channelId: CH_A, callType: 'audio', userId: 'carol' },
      { channelId: CH_A, callType: 'audio', callerName: 'alice', from: 'carol' },
    ];
    const { errors, rings } = await ringAll(alice, bob, payloads);
    expect(errors).toEqual(payloads.map(() => INVALID));
    expect(rings).toEqual([]);
  });

  it('oversized or malformed caller names are refused', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const payloads = [
      { channelId: CH_A, callType: 'audio', callerName: 'x'.repeat(10_000) },
      { channelId: CH_A, callType: 'audio', callerName: 'alice'.repeat(200) },
      { channelId: CH_A, callType: 'audio', callerName: null },
      { channelId: CH_A, callType: 'audio', callerName: 42 },
      { channelId: CH_A, callType: 'audio', callerName: { name: 'alice' } },
      { channelId: CH_A, callType: 'audio', callerName: ['alice'] },
    ];
    const { errors, rings } = await ringAll(alice, bob, payloads);
    expect(errors).toEqual(payloads.map(() => INVALID));
    expect(rings).toEqual([]);
  });

  it('malformed or missing call types are refused', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const payloads = [
      { channelId: CH_A },
      { channelId: CH_A, callType: null },
      { channelId: CH_A, callType: 42 },
      { channelId: CH_A, callType: true },
      { channelId: CH_A, callType: {} },
      { channelId: CH_A, callType: ['audio'] },
    ];
    const { errors, rings } = await ringAll(alice, bob, payloads);
    expect(errors).toEqual(payloads.map(() => INVALID));
    expect(rings).toEqual([]);
  });

  it('unsupported call types are refused (only "audio" and "video" exist)', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const payloads = ['screen', 'conference', 'AUDIO', 'Video', 'audio ', ' video', '', 'video\u0000'].map((callType) => ({ channelId: CH_A, callType }));
    const { errors, rings } = await ringAll(alice, bob, payloads);
    expect(errors).toEqual(payloads.map(() => INVALID));
    expect(rings).toEqual([]);
  });

  it('malformed payloads, channel ids and unexpected fields are refused', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const payloads = [
      null,
      42,
      'call',
      [CH_A, 'audio'],
      { callType: 'audio' },
      { channelId: '', callType: 'audio' },
      { channelId: 'x'.repeat(129), callType: 'audio' },
      { channelId: 42, callType: 'audio' },
      { channelId: { $ne: null }, callType: 'audio' },
      { channelId: CH_A, callType: 'audio', extra: 1 },
      JSON.parse(`{"channelId":"${CH_A}","callType":"audio","__proto__":{"admin":true}}`),
    ];
    const { errors, rings } = await ringAll(alice, bob, payloads);
    expect(errors).toEqual(payloads.map(() => INVALID));
    expect(rings).toEqual([]);
  });

  it('unauthorized target: non-members, other workspaces, unknown channels and removed members cannot ring', async () => {
    const [alice, bob, carol, mallory] = [await connect('alice'), await connect('bob'), await connect('carol'), await connect('mallory')];

    // Mallory (workspace M) rings Alice's channel; Alice rings a channel that does not exist.
    const fromMallory = await ringAll(mallory, bob, [{ channelId: CH_A, callType: 'audio' }]);
    expect(fromMallory).toEqual({ errors: [NOT_AUTHORIZED], rings: [] });
    const unknown = await ringAll(alice, bob, [{ channelId: '33333333-3333-4333-8333-333333333333', callType: 'video' }]);
    expect(unknown).toEqual({ errors: [NOT_AUTHORIZED], rings: [] });

    // Carol keeps her channel row (and socket room) but was removed from the workspace.
    world.workspaceMembers.delete(`carol|${WS_A}`);
    const fromRemoved = await ringAll(carol, bob, [{ channelId: CH_A, callType: 'audio' }]);
    expect(fromRemoved).toEqual({ errors: [NOT_AUTHORIZED], rings: [] });
  });

  it('the relayed caller name is bounded and never empty', async () => {
    const longName = await connect('alice', `  ${'A'.repeat(500)}  `);
    const bob = await connect('bob');
    const long = await ringAll(longName, bob, [{ channelId: CH_A, callType: 'audio' }]);
    expect(long.errors).toEqual([]);
    expect(long.rings).toEqual([{ channelId: CH_A, callerName: 'A'.repeat(80), callType: 'audio', from: 'alice' }]);

    const blank = await connect('carol', '   ');
    const empty = await ringAll(blank, bob, [{ channelId: CH_A, callType: 'video' }]);
    expect(empty.rings).toEqual([{ channelId: CH_A, callerName: 'Someone', callType: 'video', from: 'carol' }]);
  });

  it('valid existing call acceptance: the rung member joins and the WebRTC handshake relays as before', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    await joinCall(alice, CH_A); // the caller's overlay joins the call when it starts it
    const { rings } = await ringAll(alice, bob, [{ channelId: CH_A, callType: 'video' }]);
    expect(rings).toHaveLength(1);

    // Bob accepts: his overlay joins the ring's channel and offers to the existing participant.
    const { participants } = await joinCall(bob, rings[0].channelId);
    expect(participants.map((p) => p.socketId)).toEqual([alice.id]);
    const offerAtAlice = next(alice, 'webrtc:offer');
    bob.emit('webrtc:offer', { channelId: CH_A, to: alice.id, offer: OFFER });
    expect(await offerAtAlice).toEqual({ from: bob.id, channelId: CH_A, offer: OFFER });
    const answerAtBob = next(bob, 'webrtc:answer');
    alice.emit('webrtc:answer', { channelId: CH_A, to: bob.id, answer: ANSWER });
    expect(await answerAtBob).toEqual({ from: alice.id, channelId: CH_A, answer: ANSWER });
  });
});
