import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createWorkspace, TestUser } from './collab-helpers';
import { collect, emitAck, nextEvent, useSocketHarness } from './socket-harness';

const harness = useSocketHarness();

const team = async (size: number) => {
  const owner = await createAndLoginUser();
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  const people: TestUser[] = [];
  for (let i = 0; i < size; i += 1) {
    const u = await createAndLoginUser();
    await addToWorkspace(u, workspaceId, [generalChannelId]);
    people.push(u);
  }
  return { owner, people, workspaceId, generalChannelId };
};

describe('People directory & profiles', () => {
  it('lists, searches and paginates workspace members only', async () => {
    const { owner, people, workspaceId } = await team(3);
    const outsider = await createAndLoginUser();

    const all = await request(app).get(`/api/workspaces/${workspaceId}/members`).set(authHeader(owner.token));
    expect(all.status).toBe(200);
    expect(all.body.members.map((m: { id: string }) => m.id).sort()).toEqual(
      [owner, ...people].map((u) => u.user.id).sort()
    );
    expect(all.body.members.find((m: { id: string }) => m.id === owner.user.id)).toMatchObject({ isOwner: true, role: 'ADMIN' });

    const target = people[1].user.username;
    const search = await request(app)
      .get(`/api/workspaces/${workspaceId}/members`)
      .query({ q: target.slice(-6) })
      .set(authHeader(owner.token));
    expect(search.body.members.map((m: { username: string }) => m.username)).toEqual([target]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: request.Response = await request(app)
        .get(`/api/workspaces/${workspaceId}/members`)
        .query({ limit: 1, ...(cursor ? { cursor } : {}) })
        .set(authHeader(owner.token));
      seen.push(...page.body.members.map((m: { id: string }) => m.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(4);

    expect((await request(app).get(`/api/workspaces/${workspaceId}/members`).set(authHeader(outsider.token))).status).toBe(403);
  });

  it('shows a member profile with shared channels and presence; hides non-members', async () => {
    const { owner, people, workspaceId, generalChannelId } = await team(1);
    const [alice] = people;
    await request(app).patch('/api/users/me/profile').set(authHeader(alice.token)).send({ title: 'Designer', bio: 'Pixels', timezone: 'Europe/Berlin' });
    await harness.connect(alice);

    const res = await request(app).get(`/api/workspaces/${workspaceId}/members/${alice.user.id}`).set(authHeader(owner.token));
    expect(res.body).toMatchObject({
      id: alice.user.id,
      title: 'Designer',
      bio: 'Pixels',
      timezone: 'Europe/Berlin',
      role: 'MEMBER',
      isOwner: false,
      sharedChannels: [{ id: generalChannelId, name: 'General' }],
    });
    expect(res.body.presence).toMatchObject({ id: alice.user.id, status: 'active' });

    const stranger = await createAndLoginUser();
    expect((await request(app).get(`/api/workspaces/${workspaceId}/members/${stranger.user.id}`).set(authHeader(owner.token))).status).toBe(404);
  });
});

describe('workspace-scoped presence', () => {
  it('only shows people who share a workspace; admins keep the global view', async () => {
    const shared = await team(1); // owner A + member C
    const [carol] = shared.people;
    const ann = shared.owner;
    const elsewhere = await createAndLoginUser(); // B: only in their own workspace…
    const other = await createWorkspace(elsewhere);
    await addToWorkspace(carol, other.workspaceId); // …which Carol also belongs to

    const carolConn = await harness.connect(carol);
    const annConn = await harness.connect(ann);
    expect(annConn.presence.map((u) => u.id)).toEqual(expect.arrayContaining([ann.user.id, carol.user.id]));

    const annSees = collect<{ id: string }>(annConn.socket, 'user:online', 700);
    const carolSees = nextEvent<{ id: string }>(carolConn.socket, 'user:online', (u) => u.id === elsewhere.user.id);
    const bConn = await harness.connect(elsewhere);
    await carolSees;
    expect((await annSees).map((u) => u.id)).not.toContain(elsewhere.user.id);
    expect(bConn.presence.map((u) => u.id)).not.toContain(ann.user.id);

    // Status changes are validated and scoped the same way.
    const annStatus = collect<{ id: string }>(annConn.socket, 'user:online', 600);
    const carolStatus = nextEvent<{ id: string; status: string }>(carolConn.socket, 'user:online', (u) => u.id === elsewhere.user.id && u.status === 'away');
    bConn.socket.emit('user:status', { status: 'away' });
    await carolStatus;
    bConn.socket.emit('user:status', { status: '<script>' });
    expect((await annStatus).filter((u) => u.id === elsewhere.user.id)).toHaveLength(0);

    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const adminConn = await harness.connect(admin);
    expect(adminConn.presence.map((u) => u.id)).toEqual(expect.arrayContaining([ann.user.id, elsewhere.user.id, carol.user.id]));
  });

  it('sends the online counter only to platform admins', async () => {
    const { owner } = await team(0);
    const userConn = await harness.connect(owner);
    const counters = collect(userConn.socket, 'admin:stats:onlineCount', 700);
    await harness.connect(await createAndLoginUser());
    expect(await counters).toHaveLength(0);
  });
});

describe('membership removal & revocation', () => {
  it('a removed workspace member loses rooms, presence and API access immediately', async () => {
    const { owner, people, workspaceId, generalChannelId } = await team(2);
    const [mallory, alice] = people;
    const ownerConn = await harness.connect(owner);
    const malloryConn = await harness.connect(mallory);
    const aliceConn = await harness.connect(alice);

    const removedEvent = nextEvent<{ workspaceId: string; reason: string }>(malloryConn.socket, 'workspace:removed');
    const offlineForAlice = nextEvent<{ id: string }>(aliceConn.socket, 'user:offline', (u) => u.id === mallory.user.id);
    const res = await request(app).delete(`/api/workspaces/${workspaceId}/members/${mallory.user.id}`).set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(await removedEvent).toEqual({ workspaceId, reason: 'removed' });
    await offlineForAlice;

    const leaked = collect(malloryConn.socket, 'message:received', 700);
    await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: 'after removal' });
    expect(await leaked).toHaveLength(0);
    expect((await emitAck(malloryConn.socket, 'message:send', { channelId: generalChannelId, content: 'hi?' })).ok).toBe(false);
    expect((await emitAck(malloryConn.socket, 'channel:join', generalChannelId)).ok).toBe(false);

    for (const path of [
      `/api/workspaces/${workspaceId}/channels`,
      `/api/workspaces/${workspaceId}/members`,
      `/api/channels/${generalChannelId}/messages`,
      `/api/workspaces/${workspaceId}/unread`,
    ]) {
      expect((await request(app).get(path).set(authHeader(mallory.token))).status, path).toBe(403);
    }
    // The authentication record itself is untouched.
    expect(await prisma.user.findUnique({ where: { id: mallory.user.id } })).not.toBeNull();
  });

  it('enforces who may remove whom', async () => {
    const { owner, people, workspaceId } = await team(3);
    const [admin, member, otherAdmin] = people;
    await prisma.workspaceMember.updateMany({
      where: { workspaceId, userId: { in: [admin.user.id, otherAdmin.user.id] } },
      data: { role: 'ADMIN' },
    });
    const del = (actor: TestUser, target: TestUser) =>
      request(app).delete(`/api/workspaces/${workspaceId}/members/${target.user.id}`).set(authHeader(actor.token));

    expect((await del(member, admin)).status).toBe(403); // members can't remove
    expect((await del(admin, owner)).status).toBe(403); // nobody removes the owner
    expect((await del(admin, otherAdmin)).status).toBe(403); // only the owner removes admins
    expect((await del(admin, admin)).status).toBe(400); // use leave instead
    expect((await del(admin, member)).status).toBe(200);
    expect((await del(owner, otherAdmin)).status).toBe(200);
  });

  it('members can leave (the owner cannot); the default workspace is exempt', async () => {
    const { owner, people, workspaceId } = await team(1);
    const [alice] = people;
    const aliceConn = await harness.connect(alice);
    const removed = nextEvent<{ reason: string }>(aliceConn.socket, 'workspace:removed');
    expect((await request(app).post(`/api/workspaces/${workspaceId}/leave`).set(authHeader(alice.token))).status).toBe(200);
    expect((await removed).reason).toBe('left');
    expect((await request(app).post(`/api/workspaces/${workspaceId}/leave`).set(authHeader(owner.token))).status).toBe(400);

    const defaults = await team(1);
    await prisma.workspace.update({ where: { id: defaults.workspaceId }, data: { isDefault: true } });
    try {
      const res = await request(app)
        .delete(`/api/workspaces/${defaults.workspaceId}/members/${defaults.people[0].user.id}`)
        .set(authHeader(defaults.owner.token));
      expect(res.status).toBe(400);
    } finally {
      await prisma.workspace.update({ where: { id: defaults.workspaceId }, data: { isDefault: false } });
    }
  });

  it('channel leave and removal revoke just that channel', async () => {
    const { owner, people, workspaceId, generalChannelId } = await team(2);
    const [alice, bob] = people;
    const created = await request(app).post('/api/channels').set(authHeader(owner.token)).send({ workspaceId, name: `ops-${Date.now()}` });
    const channelId = created.body.id as string;
    for (const u of [alice, bob]) await prisma.channelMember.create({ data: { userId: u.user.id, channelId } });

    const ownerConn = await harness.connect(owner);
    const aliceConn = await harness.connect(alice);
    const bobConn = await harness.connect(bob);

    expect((await request(app).post(`/api/channels/${generalChannelId}/leave`).set(authHeader(alice.token))).status).toBe(400);
    expect((await request(app).delete(`/api/channels/${channelId}/members/${alice.user.id}`).set(authHeader(bob.token))).status).toBe(403);

    const removed = nextEvent<{ channelId: string }>(aliceConn.socket, 'conversation:removed');
    expect((await request(app).delete(`/api/channels/${channelId}/members/${alice.user.id}`).set(authHeader(owner.token))).status).toBe(200);
    expect(await removed).toEqual({ channelId });

    expect((await request(app).post(`/api/channels/${channelId}/leave`).set(authHeader(bob.token))).status).toBe(200);

    const aliceLeaks = collect(aliceConn.socket, 'message:received', 700);
    const bobLeaks = collect(bobConn.socket, 'message:received', 700);
    await emitAck(ownerConn.socket, 'message:send', { channelId, content: 'ops only' });
    expect(await aliceLeaks).toHaveLength(0);
    expect(await bobLeaks).toHaveLength(0);

    // Still in General.
    const general = nextEvent(aliceConn.socket, 'message:received', (m) => m.channelId === generalChannelId);
    await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: 'general still works' });
    await general;
  });

  it('deleting a workspace revokes every member immediately', async () => {
    const { owner, people, workspaceId } = await team(1);
    await harness.connect(owner);
    const aliceConn = await harness.connect(people[0]);
    expect(aliceConn.presence.map((u) => u.id)).toContain(owner.user.id);

    const removed = nextEvent<{ reason: string }>(aliceConn.socket, 'workspace:removed');
    // Presence is recomputed: with no shared workspace left, the owner disappears.
    const recomputed = nextEvent<{ users: { id: string }[] }>(
      aliceConn.socket,
      'presence:init',
      (p) => !p.users.some((u) => u.id === owner.user.id)
    );
    expect((await request(app).delete(`/api/workspaces/${workspaceId}`).set(authHeader(owner.token))).status).toBe(200);
    expect((await removed).reason).toBe('deleted');
    await recomputed;
  });
});
