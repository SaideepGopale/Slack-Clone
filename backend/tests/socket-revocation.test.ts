import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { getSocketServer } from '../sockets/registry';
import { addToWorkspace, createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser } from './helpers';
import { collect, emitAck, nextEvent, useSocketHarness } from './socket-harness';

/**
 * P1-B — FA-RT-03: deleting a user (DELETE /api/admin/users/:id) revokes their
 * live Socket.IO sessions at once; their room memberships, presence and calls
 * are cleaned up; reconnecting is refused; everyone else is unaffected.
 * Real app, real sockets, disposable test database.
 */
const { connect } = useSocketHarness();

/** A workspace (owner) with two more members — the user who gets deleted and a bystander — plus a platform admin. */
const setup = async () => {
  const admin = await createAndLoginUser({ role: 'ADMIN' });
  const owner = await createAndLoginUser();
  const victim = await createAndLoginUser();
  const other = await createAndLoginUser();
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  await addToWorkspace(victim, workspaceId, [generalChannelId]);
  await addToWorkspace(other, workspaceId, [generalChannelId]);
  return { admin, owner, victim, other, workspaceId, generalChannelId };
};

const deleteUser = (admin: TestUser, userId: string) => request(app).delete(`/api/admin/users/${userId}`).set(authHeader(admin.token));

const socketIdsIn = async (room: string) => (await getSocketServer()!.in(room).fetchSockets()).map((s) => s.id);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('deleted users lose their live socket sessions (FA-RT-03)', () => {
  it("deleting a connected user disconnects every one of their sockets, and nobody else's", async () => {
    const w = await setup();
    const tabs = [await connect(w.victim), await connect(w.victim)]; // two tabs/devices
    const bystanders = [await connect(w.other), await connect(w.owner), await connect(w.admin)];
    const victimSocketIds = tabs.map((t) => t.socket.id!);
    const reasons = tabs.map((t) => new Promise<string>((resolve) => t.socket.once('disconnect', resolve)));
    const bystanderDrops: string[] = [];
    for (const b of bystanders) b.socket.on('disconnect', (reason) => bystanderDrops.push(reason));

    const res = await deleteUser(w.admin, w.victim.user.id);
    expect(res.status).toBe(200);
    expect(await Promise.all(reasons)).toEqual(['io server disconnect', 'io server disconnect']);

    // Server side: the sessions are gone, and so are their room memberships.
    const io = getSocketServer()!;
    for (const id of victimSocketIds) expect(io.sockets.sockets.has(id)).toBe(false);
    for (const room of [`user:${w.victim.user.id}`, `ws:${w.workspaceId}`, w.generalChannelId]) {
      const members = await socketIdsIn(room);
      for (const id of victimSocketIds) expect(members).not.toContain(id);
    }
    expect(await socketIdsIn(`user:${w.victim.user.id}`)).toEqual([]);

    await sleep(300);
    expect(bystanderDrops).toEqual([]);
    expect(bystanders.every((b) => b.socket.connected)).toBe(true);
  });

  it('cleans up presence and live calls: others see the user go offline and leave the call', async () => {
    const w = await setup();
    const owner = await connect(w.owner);
    const victim = await connect(w.victim);
    const ownerJoined = nextEvent(owner.socket, 'webrtc:existing-participants');
    owner.socket.emit('webrtc:join', { channelId: w.generalChannelId });
    await ownerJoined;
    const peerJoined = nextEvent<{ socketId: string }>(owner.socket, 'webrtc:peer-joined');
    victim.socket.emit('webrtc:join', { channelId: w.generalChannelId });
    expect((await peerJoined).socketId).toBe(victim.socket.id);
    const victimSocketId = victim.socket.id;

    const offline = nextEvent<{ id: string }>(owner.socket, 'user:offline', (p) => p.id === w.victim.user.id);
    const peerLeft = nextEvent<{ socketId: string }>(owner.socket, 'webrtc:peer-left');
    expect((await deleteUser(w.admin, w.victim.user.id)).status).toBe(200);

    expect(await peerLeft).toEqual({ socketId: victimSocketId });
    await offline;
    expect(await socketIdsIn(`call:${w.generalChannelId}`)).toEqual([owner.socket.id]);
  });

  it('the deleted user receives nothing more, cannot send, and cannot reconnect', async () => {
    const w = await setup();
    const victim = await connect(w.victim);
    const other = await connect(w.other);
    await sleep(200); // let the connection-time presence events settle
    const received: string[] = [];
    victim.socket.onAny((event) => received.push(event));

    const gone = new Promise((resolve) => victim.socket.once('disconnect', resolve));
    expect((await deleteUser(w.admin, w.victim.user.id)).status).toBe(200);
    await gone;

    // Protected traffic after the deletion never reaches the deleted user.
    expect((await emitAck(other.socket, 'message:send', { channelId: w.generalChannelId, content: '<p>after the deletion</p>' })).ok).toBe(true);
    other.socket.emit('call:initiate', { channelId: w.generalChannelId, callType: 'audio' });
    other.socket.emit('user:status', { status: 'away' });

    // What the deleted user tries to send is never delivered: the client can
    // only queue it, and reconnecting with the still-unexpired token is refused.
    const otherSaw = collect<{ content: string }>(other.socket, 'message:received', 1500);
    victim.socket.emit('message:send', { channelId: w.generalChannelId, content: '<p>from a deleted account</p>' });
    const refused = new Promise<Error>((resolve) => victim.socket.once('connect_error', resolve));
    victim.socket.connect();
    expect((await refused).message).toBe('Account suspended');
    expect(victim.socket.connected).toBe(false);
    expect((await otherSaw).filter((m) => m.content.includes('deleted account'))).toEqual([]);
    expect(await prisma.message.count({ where: { content: { contains: 'from a deleted account' } } })).toBe(0);
    expect(received).toEqual([]);

    // A brand-new connection with that token is refused too.
    await expect(connect(w.victim)).rejects.toThrow('Account suspended');
  });

  it('a deletion that does not happen revokes nothing (not an admin, no token, unknown user, self-deletion)', async () => {
    const w = await setup();
    const victim = await connect(w.victim);
    const admin = await connect(w.admin);
    const drops: string[] = [];
    for (const c of [victim, admin]) c.socket.on('disconnect', (reason) => drops.push(reason));

    expect((await deleteUser(w.other, w.victim.user.id)).status).toBe(403);
    expect((await request(app).delete(`/api/admin/users/${w.victim.user.id}`)).status).toBe(401);
    expect((await deleteUser(w.admin, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await deleteUser(w.admin, w.admin.user.id)).status).toBe(400);

    await sleep(500);
    expect(drops).toEqual([]);
    expect(victim.socket.connected && admin.socket.connected).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: w.victim.user.id } })).not.toBeNull();
  });

  it('everyone else keeps messaging, presence and reconnecting normally after the deletion', async () => {
    const w = await setup();
    const victim = await connect(w.victim);
    const other = await connect(w.other);
    const owner = await connect(w.owner);
    const gone = new Promise((resolve) => victim.socket.once('disconnect', resolve));
    expect((await deleteUser(w.admin, w.victim.user.id)).status).toBe(200);
    await gone;

    const atOwner = nextEvent<{ content: string }>(owner.socket, 'message:received', (m) => m.content.includes('still here'));
    expect((await emitAck(other.socket, 'message:send', { channelId: w.generalChannelId, content: '<p>still here</p>' })).ok).toBe(true);
    await atOwner;

    const away = nextEvent<{ id: string; status: string }>(owner.socket, 'user:online', (p) => p.id === w.other.user.id && p.status === 'away');
    other.socket.emit('user:status', { status: 'away' });
    await away;

    const third = await createAndLoginUser();
    await addToWorkspace(third, w.workspaceId, [w.generalChannelId]);
    const online = nextEvent<{ id: string }>(owner.socket, 'user:online', (p) => p.id === third.user.id);
    await connect(third);
    await online;

    other.socket.disconnect();
    const again = await connect(w.other);
    expect(again.channelIds).toContain(w.generalChannelId);
  });

  it("a session that lands in the deleted user's room just after the first sweep is caught by the second", async () => {
    // Simulates a socket whose handshake read the user an instant before the
    // deletion committed (not reproducible deterministically): right after the
    // first sweep, a live socket is placed in the deleted user's personal room.
    const w = await setup();
    const victim = await connect(w.victim);
    const gone = new Promise((resolve) => victim.socket.once('disconnect', resolve));
    expect((await deleteUser(w.admin, w.victim.user.id)).status).toBe(200);
    await gone;

    const straggler = await connect(w.other);
    getSocketServer()!.in(straggler.socket.id!).socketsJoin(`user:${w.victim.user.id}`);
    const started = Date.now();
    const reason = await new Promise<string>((resolve) => straggler.socket.once('disconnect', resolve));
    expect(reason).toBe('io server disconnect');
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
