import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as ioClient, Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { createSocketServer } from '../sockets';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace, seedMessage, TestUser, trustedUploadUrl } from './collab-helpers';

/**
 * End-to-end Socket.IO tests: a real HTTP + Socket.IO server on an ephemeral
 * port, real socket.io-client connections, real Postgres. Covers the
 * messaging-engine guarantees added in Batch 1 (subscriptions, reconnection,
 * idempotency, authorization, validation, ordering of concurrent writes).
 */

let httpServer: HttpServer;
let ioServer: Server;
let baseUrl: string;
const openSockets: Socket[] = [];

beforeAll(async () => {
  httpServer = createServer(app);
  ioServer = createSocketServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(() => {
  for (const s of openSockets) s.disconnect();
  openSockets.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => ioServer.close(() => resolve()));
});

interface Connected {
  socket: Socket;
  channelIds: string[];
}

const connect = (user: TestUser): Promise<Connected> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth: { token: user.token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    openSockets.push(socket);
    const timer = setTimeout(() => reject(new Error('socket did not become ready')), 5000);
    socket.once('subscriptions:ready', (payload: { channelIds: string[] }) => {
      clearTimeout(timer);
      resolve({ socket, channelIds: payload.channelIds });
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

interface AckResult {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
  message?: Record<string, unknown> & { id: string };
}

const emitAck = (socket: Socket, event: string, payload: unknown): Promise<AckResult> =>
  new Promise((resolve) => {
    socket.timeout(5000).emit(event, payload, (err: Error | null, res: AckResult) =>
      resolve(err ? { ok: false, error: 'ack timeout' } : res)
    );
  });

const nextEvent = <T = Record<string, unknown>>(
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

const collect = async <T = Record<string, unknown>>(socket: Socket, event: string, ms: number): Promise<T[]> => {
  const seen: T[] = [];
  const handler = (payload: T) => seen.push(payload);
  socket.on(event, handler);
  await new Promise((r) => setTimeout(r, ms));
  socket.off(event, handler);
  return seen;
};

const setupTeam = async (extraMembers = 1) => {
  const owner = await createAndLoginUser();
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  const members: TestUser[] = [];
  for (let i = 0; i < extraMembers; i += 1) {
    const m = await createAndLoginUser();
    await addToWorkspace(m, workspaceId, [generalChannelId]);
    members.push(m);
  }
  return { owner, members, workspaceId, generalChannelId };
};

describe('subscriptions and delivery', () => {
  it('subscribes to every authorized channel on connect — no channel:join needed', async () => {
    const { owner, members, generalChannelId } = await setupTeam();
    const [member] = members;
    const { workspaceId } = (await prisma.channel.findUnique({ where: { id: generalChannelId } }))!;
    const second = await request(app)
      .post('/api/channels')
      .set(authHeader(owner.token))
      .send({ workspaceId, name: `design-${Date.now()}` });
    await prisma.channelMember.create({ data: { userId: member.user.id, channelId: second.body.id } });

    const ownerConn = await connect(owner);
    const memberConn = await connect(member);
    expect(memberConn.channelIds).toEqual(expect.arrayContaining([generalChannelId, second.body.id]));

    for (const channelId of [generalChannelId, second.body.id]) {
      const received = nextEvent<{ channelId: string; content: string }>(
        memberConn.socket,
        'message:received',
        (m) => m.channelId === channelId
      );
      const ack = await emitAck(ownerConn.socket, 'message:send', { channelId, content: `<p>hi ${channelId}</p>` });
      expect(ack.ok).toBe(true);
      expect((await received).content).toBe(`<p>hi ${channelId}</p>`);
    }
  });

  it('channel:join never drops other subscriptions, and admin kicks still reach the socket', async () => {
    const { owner, members, generalChannelId, workspaceId } = await setupTeam();
    const [member] = members;
    const other = await request(app)
      .post('/api/channels')
      .set(authHeader(owner.token))
      .send({ workspaceId, name: `random-${Date.now()}` });
    await prisma.channelMember.create({ data: { userId: member.user.id, channelId: other.body.id } });

    const ownerConn = await connect(owner);
    const memberConn = await connect(member);
    expect((await emitAck(memberConn.socket, 'channel:join', other.body.id)).ok).toBe(true);

    const received = nextEvent(memberConn.socket, 'message:received', (m) => m.channelId === generalChannelId);
    await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: 'still subscribed?' });
    await received;

    // Previously channel:join left the personal user:<id> room, so this
    // suspension never disconnected the live socket (audit RT-01).
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const disconnected = nextEvent(memberConn.socket, 'disconnect', () => true, 5000);
    const res = await request(app)
      .patch(`/api/admin/users/${member.user.id}/status`)
      .set(authHeader(admin.token))
      .send({ status: 'SUSPENDED' });
    expect(res.status).toBe(200);
    await disconnected;
  });

  it('a non-member cannot subscribe, receive, post, or relay typing to a channel', async () => {
    const { owner, generalChannelId } = await setupTeam(0);
    const outsider = await createAndLoginUser();
    const ownerConn = await connect(owner);
    const outsiderConn = await connect(outsider);

    expect((await emitAck(outsiderConn.socket, 'channel:join', generalChannelId)).ok).toBe(false);

    const leaked = collect(outsiderConn.socket, 'message:received', 600);
    await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: 'private' });
    expect(await leaked).toHaveLength(0);

    const post = await emitAck(outsiderConn.socket, 'message:send', { channelId: generalChannelId, content: 'intrude' });
    expect(post.ok).toBe(false);
    expect(await prisma.message.count({ where: { senderId: outsider.user.id } })).toBe(0);

    const typing = collect(ownerConn.socket, 'typing:started', 500);
    outsiderConn.socket.emit('typing:start', { channelId: generalChannelId });
    expect(await typing).toHaveLength(0);
  });

  it('a DM created over REST reaches the recipient immediately, without reconnecting', async () => {
    const { owner, members, workspaceId } = await setupTeam();
    const [member] = members;
    const ownerConn = await connect(owner);
    const memberConn = await connect(member);

    const announced = nextEvent<{ id: string; name: string; otherUserId: string }>(memberConn.socket, 'dm:created');
    const dm = await createDM(owner, member, workspaceId);
    const event = await announced;
    expect(event).toMatchObject({ id: dm.id, name: owner.user.username, otherUserId: owner.user.id });

    const received = nextEvent(memberConn.socket, 'message:received', (m) => m.channelId === dm.id);
    expect((await emitAck(ownerConn.socket, 'message:send', { channelId: dm.id, content: 'psst' })).ok).toBe(true);
    await received;
  });

  it('relays typing indicators with the channel and user id', async () => {
    const { owner, members, generalChannelId } = await setupTeam();
    const ownerConn = await connect(owner);
    const memberConn = await connect(members[0]);
    const typing = nextEvent<{ channelId: string; userId: string }>(memberConn.socket, 'typing:started');
    ownerConn.socket.emit('typing:start', { channelId: generalChannelId });
    expect(await typing).toMatchObject({ channelId: generalChannelId, userId: owner.user.id });
  });

  it('P3: tells the conversation a typist stopped when they disconnect mid-typing', async () => {
    const { owner, members, generalChannelId } = await setupTeam();
    const ownerConn = await connect(owner);
    const memberConn = await connect(members[0]);
    const started = nextEvent(memberConn.socket, 'typing:started');
    ownerConn.socket.emit('typing:start', { channelId: generalChannelId });
    await started;
    const stopped = nextEvent<{ channelId: string; userId: string }>(memberConn.socket, 'typing:stopped');
    ownerConn.socket.disconnect();
    expect(await stopped).toMatchObject({ channelId: generalChannelId, userId: owner.user.id });
  });
});

describe('reliability', () => {
  it('is idempotent per clientId — sequential and concurrent retries never duplicate', async () => {
    const { owner, members, generalChannelId } = await setupTeam();
    const ownerConn = await connect(owner);
    const memberConn = await connect(members[0]);
    const deliveries = collect<{ clientId: string }>(memberConn.socket, 'message:received', 1200);

    const payload = { channelId: generalChannelId, content: 'exactly once', clientId: 'client-abc-12345' };
    const [a, b] = await Promise.all([
      emitAck(ownerConn.socket, 'message:send', payload),
      emitAck(ownerConn.socket, 'message:send', payload),
    ]);
    const c = await emitAck(ownerConn.socket, 'message:send', payload);

    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    expect(new Set([a.message!.id, b.message!.id, c.message!.id]).size).toBe(1);
    expect(c.duplicate).toBe(true);
    expect(await prisma.message.count({ where: { senderId: owner.user.id, clientId: payload.clientId } })).toBe(1);
    expect((await deliveries).filter((m) => m.clientId === payload.clientId)).toHaveLength(1);
  });

  it('restores subscriptions after a reconnect; missed messages are recoverable via ?after=', async () => {
    const { owner, members, generalChannelId, workspaceId } = await setupTeam();
    const [member] = members;
    const ownerConn = await connect(owner);
    const first = await connect(member);

    const anchorAck = await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: 'before' });
    first.socket.disconnect();
    const missedAck = await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: 'while offline' });
    expect(missedAck.ok).toBe(true);

    const second = await connect(member);
    expect(second.channelIds).toContain(generalChannelId);

    const backfill = await request(app)
      .get(`/api/channels/${generalChannelId}/messages`)
      .query({ after: anchorAck.message!.id })
      .set(authHeader(member.token));
    expect(backfill.body.messages.map((m: { content: string }) => m.content)).toEqual(['while offline']);

    const live = nextEvent(second.socket, 'message:received', (m) => m.content === 'after reconnect');
    await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: 'after reconnect' });
    await live;
    expect(workspaceId).toBeTruthy();
  });

  it('serializes concurrent poll votes — no lost updates', async () => {
    const { owner, members, generalChannelId } = await setupTeam(3);
    const conns = await Promise.all([owner, ...members].map((u) => connect(u)));
    const poll = await emitAck(conns[0].socket, 'message:send', {
      channelId: generalChannelId,
      content: 'Poll',
      pollData: { question: 'Lunch?', options: ['Pizza', 'Sushi'] },
    });
    expect(poll.ok).toBe(true);

    const votes = await Promise.all(
      conns.map((c, i) => emitAck(c.socket, 'poll:vote', { messageId: poll.message!.id, optionId: `opt-${i % 2}` }))
    );
    expect(votes.every((v) => v.ok)).toBe(true);

    const stored = await prisma.message.findUnique({ where: { id: poll.message!.id } });
    const options = (stored!.pollData as { options: { votes: string[] }[] }).options;
    expect(options.flatMap((o) => o.votes).sort()).toEqual([owner, ...members].map((u) => u.user.id).sort());
  });
});

describe('authorization and validation of message events', () => {
  it('rejects thread replies whose parent is in another channel, and never leaks parent content', async () => {
    const { owner, members, generalChannelId, workspaceId } = await setupTeam();
    const elsewhere = await setupTeam(0);
    const foreignParent = await seedMessage(
      elsewhere.generalChannelId,
      elsewhere.workspaceId,
      elsewhere.owner.user.id,
      'confidential roadmap'
    );
    const ownerConn = await connect(owner);
    const memberConn = await connect(members[0]);

    const cross = await emitAck(ownerConn.socket, 'message:send', {
      channelId: generalChannelId,
      content: 'reply',
      parentId: foreignParent.id,
    });
    expect(cross.ok).toBe(false);
    expect(JSON.stringify(cross)).not.toContain('confidential roadmap');

    const parent = await seedMessage(generalChannelId, workspaceId, owner.user.id, 'local parent');
    const received = nextEvent<Record<string, unknown>>(memberConn.socket, 'message:received', (m) => m.parentId === parent.id);
    const reply = await emitAck(ownerConn.socket, 'message:send', {
      channelId: generalChannelId,
      content: 'valid reply',
      parentId: parent.id,
    });
    expect(reply.ok).toBe(true);
    expect(await received).not.toHaveProperty('parent');

    const nested = await emitAck(ownerConn.socket, 'message:send', {
      channelId: generalChannelId,
      content: 'nested',
      parentId: reply.message!.id,
    });
    expect(nested.ok).toBe(false);
  });

  it('validates attachments, polls and content on the server', async () => {
    const { owner, generalChannelId } = await setupTeam(0);
    const { socket } = await connect(owner);

    const external = await emitAck(socket, 'message:send', {
      channelId: generalChannelId,
      fileUrl: 'https://evil.example.com/workspace-uploads/x.pdf',
      fileName: 'invoice.pdf',
    });
    expect(external.ok).toBe(false);

    const trusted = await emitAck(socket, 'message:send', {
      channelId: generalChannelId,
      fileUrl: trustedUploadUrl('report.pdf'),
      fileName: 'report\u0000.pdf',
      fileType: 'application/pdf',
    });
    expect(trusted.ok).toBe(true);
    expect(trusted.message).toMatchObject({ fileName: 'report.pdf', fileType: 'application/pdf' });

    const forged = await emitAck(socket, 'message:send', {
      channelId: generalChannelId,
      pollData: { question: 'Q?', options: [{ id: 'x', text: 'A', votes: ['someone'] }, { text: 'B', votes: ['a', 'b'] }] },
    });
    expect(forged.ok).toBe(true);
    expect(forged.message!.pollData).toEqual({
      question: 'Q?',
      options: [
        { id: 'opt-0', text: 'A', votes: [] },
        { id: 'opt-1', text: 'B', votes: [] },
      ],
    });

    expect((await emitAck(socket, 'message:send', { channelId: generalChannelId, content: '<p></p>' })).ok).toBe(false);
    expect((await emitAck(socket, 'message:send', { channelId: generalChannelId, content: 'x'.repeat(20_001) })).ok).toBe(false);

    const scripted = await emitAck(socket, 'message:send', {
      channelId: generalChannelId,
      content: '<p>hi<script>alert(1)</script><img src=x onerror=alert(1)></p>',
    });
    expect(scripted.ok).toBe(true);
    expect(scripted.message!.content).toBe('<p>hi</p>');
  });

  it('only the author can edit or delete, and changes are broadcast', async () => {
    const { owner, members, generalChannelId } = await setupTeam();
    const ownerConn = await connect(owner);
    const memberConn = await connect(members[0]);
    const sent = await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: 'original' });
    const id = sent.message!.id;

    expect((await emitAck(memberConn.socket, 'message:edit', { id, content: 'hijacked' })).ok).toBe(false);
    const updated = nextEvent<{ id: string; content: string }>(memberConn.socket, 'message:updated', (m) => m.id === id);
    expect((await emitAck(ownerConn.socket, 'message:edit', { id, content: '<p>edited</p>' })).ok).toBe(true);
    expect((await updated).content).toBe('<p>edited</p>');

    expect((await emitAck(memberConn.socket, 'message:delete', { id })).ok).toBe(false);
    const deleted = nextEvent<string>(memberConn.socket, 'message:deleted', (m) => m === id);
    expect((await emitAck(ownerConn.socket, 'message:delete', { id })).ok).toBe(true);
    await deleted;
    expect(await prisma.message.findUnique({ where: { id } })).toBeNull();
  });
});
