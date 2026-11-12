import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace, seedMessage, TestUser } from './collab-helpers';
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

const createGroup = (creator: TestUser, workspaceId: string, users: TestUser[], name?: string) =>
  request(app)
    .post(`/api/workspaces/${workspaceId}/group-dms`)
    .set(authHeader(creator.token))
    .send({ userIds: users.map((u) => u.user.id), name });

describe('group DM creation', () => {
  it('validates participants and size', async () => {
    const { owner, people, workspaceId } = await team(9);
    const outsider = await createAndLoginUser();
    expect((await createGroup(owner, workspaceId, people.slice(0, 1))).status).toBe(400); // only one other → use a DM
    expect((await createGroup(owner, workspaceId, people.slice(0, 9))).status).toBe(400); // 10 people > 9
    expect((await createGroup(owner, workspaceId, [people[0], outsider])).status).toBe(400); // non-member
    const bad = await request(app)
      .post(`/api/workspaces/${workspaceId}/group-dms`)
      .set(authHeader(owner.token))
      .send({ userIds: ['nope', 'x'] });
    expect(bad.status).toBe(400);
    expect((await createGroup(outsider, workspaceId, people.slice(0, 2))).status).toBe(403); // not in workspace
  });

  it('creates once per set of people, names it for each viewer, and keeps 1:1 DMs separate', async () => {
    const { owner, people, workspaceId } = await team(2);
    const [alice, bob] = people;
    const first = await createGroup(owner, workspaceId, [alice, bob]);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ isDM: true, isGroupDM: true, created: true, otherUserId: null });
    expect(first.body.name).toBe([alice.user.username, bob.user.username].sort().join(', '));
    expect(first.body.participants).toHaveLength(3);

    const again = await createGroup(alice, workspaceId, [owner, bob]);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, created: false });

    const dm = await createDM(owner, alice, workspaceId);
    expect(dm.id).not.toBe(first.body.id);

    const list = await request(app).get(`/api/workspaces/${workspaceId}/dms`).set(authHeader(bob.token));
    const group = list.body.find((c: { id: string }) => c.id === first.body.id);
    expect(group).toMatchObject({ isGroupDM: true, name: [alice.user.username, owner.user.username].sort().join(', ') });
  });

  it('notifies participants and delivers messages to all of them in real time', async () => {
    const { owner, people, workspaceId } = await team(2);
    const [alice, bob] = people;
    const ownerConn = await harness.connect(owner);
    const aliceConn = await harness.connect(alice);
    const announced = nextEvent<{ id: string; isGroupDM: boolean }>(aliceConn.socket, 'dm:created');
    const res = await createGroup(owner, workspaceId, [alice, bob], 'Launch crew');
    expect(await announced).toMatchObject({ id: res.body.id, isGroupDM: true });

    const received = nextEvent(aliceConn.socket, 'message:received', (m) => m.channelId === res.body.id);
    expect((await emitAck(ownerConn.socket, 'message:send', { channelId: res.body.id, content: 'kickoff' })).ok).toBe(true);
    await received;

    const outsider = await createAndLoginUser();
    await addToWorkspace(outsider, workspaceId);
    expect((await request(app).post(`/api/channels/${res.body.id}/join`).set(authHeader(outsider.token))).status).toBe(403);
  });
});

describe('group DM membership and history', () => {
  const setup = async () => {
    const { owner, people, workspaceId } = await team(3);
    const [alice, bob, carol] = people;
    const res = await createGroup(owner, workspaceId, [alice, bob], 'Project X');
    const channelId = res.body.id as string;
    const old = await seedMessage(channelId, workspaceId, alice.user.id, 'confidential early plan', {
      createdAt: new Date(Date.now() - 60_000),
    });
    return { owner, alice, bob, carol, workspaceId, channelId, old };
  };

  it('adds a person WITHOUT prior history by default — on every read path', async () => {
    const { owner, carol, channelId, old } = await setup();
    const add = await request(app).post(`/api/channels/${channelId}/participants`).set(authHeader(owner.token)).send({ userId: carol.user.id });
    expect(add.status).toBe(201);
    expect(add.body.participants).toHaveLength(4);
    const fresh = await seedMessage(channelId, old.workspaceId, owner.user.id, 'welcome carol', { createdAt: new Date(Date.now() + 1000) });

    const page = await request(app).get(`/api/channels/${channelId}/messages`).set(authHeader(carol.token));
    expect(page.body.messages.map((m: { content: string }) => m.content)).toEqual(['welcome carol']);
    const search = await request(app).get(`/api/channels/${channelId}/search`).query({ q: 'confidential' }).set(authHeader(carol.token));
    expect(search.body).toEqual([]);
    expect((await request(app).get(`/api/messages/${old.id}/thread`).set(authHeader(carol.token))).status).toBe(404);
    expect(
      (await request(app).post(`/api/messages/${old.id}/reactions`).set(authHeader(carol.token)).send({ emoji: '👍' })).status
    ).toBe(404);
    const after = await request(app).get(`/api/channels/${channelId}/messages`).query({ after: old.id }).set(authHeader(carol.token));
    expect(after.status).toBe(400);

    const carolConn = await harness.connect(carol);
    expect((await emitAck(carolConn.socket, 'message:send', { channelId, content: 'r', parentId: old.id })).ok).toBe(false);
    expect((await emitAck(carolConn.socket, 'message:pin', { id: old.id, isPinned: true })).ok).toBe(false);
    expect((await emitAck(carolConn.socket, 'thread:join', { messageId: old.id })).ok).toBe(false);

    const dms = await request(app).get(`/api/workspaces/${old.workspaceId}/dms`).set(authHeader(carol.token));
    expect(dms.body.find((d: { id: string }) => d.id === channelId).lastMessage).toMatchObject({ id: fresh.id });
  });

  it('can share prior history when explicitly asked', async () => {
    const { owner, carol, channelId } = await setup();
    await request(app)
      .post(`/api/channels/${channelId}/participants`)
      .set(authHeader(owner.token))
      .send({ userId: carol.user.id, shareHistory: true });
    const page = await request(app).get(`/api/channels/${channelId}/messages`).set(authHeader(carol.token));
    expect(page.body.messages.map((m: { content: string }) => m.content)).toContain('confidential early plan');
  });

  it("P3 (FA-SEC-08): can't share more history than the person adding them can see", async () => {
    const { owner, carol, channelId, workspaceId } = await setup();
    const dave = await createAndLoginUser();
    await addToWorkspace(dave, workspaceId, []);
    // Carol joins without history, then adds Dave asking to "share history".
    await request(app).post(`/api/channels/${channelId}/participants`).set(authHeader(owner.token)).send({ userId: carol.user.id });
    const add = await request(app)
      .post(`/api/channels/${channelId}/participants`)
      .set(authHeader(carol.token))
      .send({ userId: dave.user.id, shareHistory: true });
    expect(add.status).toBe(201);
    const page = await request(app).get(`/api/channels/${channelId}/messages`).set(authHeader(dave.token));
    expect(page.body.messages.map((m: { content: string }) => m.content)).not.toContain('confidential early plan');
  });

  it('P3 (FA-RT-05): edits and pins of older messages never reach members who joined without that history', async () => {
    const { owner, alice, carol, channelId, old } = await setup();
    await request(app).post(`/api/channels/${channelId}/participants`).set(authHeader(owner.token)).send({ userId: carol.user.id });
    const carolConn = await harness.connect(carol);
    const ownerConn = await harness.connect(owner);
    const aliceConn = await harness.connect(alice);
    const carolSees = collect<{ id: string }>(carolConn.socket, 'message:updated', 1200);
    const ownerSees = nextEvent<{ id: string; content: string }>(ownerConn.socket, 'message:updated', (m) => m.id === old.id);

    expect((await emitAck(aliceConn.socket, 'message:edit', { id: old.id, content: 'revised confidential plan' })).ok).toBe(true);
    expect((await emitAck(aliceConn.socket, 'message:pin', { id: old.id, isPinned: true })).ok).toBe(true);
    expect((await ownerSees).content).toContain('revised confidential plan');
    expect((await carolSees).filter((m) => m.id === old.id)).toEqual([]);
  });

  it('only the creator can remove others; removal revokes rooms and API access immediately', async () => {
    const { owner, alice, bob, channelId } = await setup();
    const aliceConn = await harness.connect(alice);
    const bobConn = await harness.connect(bob);
    const ownerConn = await harness.connect(owner);

    const forbidden = await request(app).delete(`/api/channels/${channelId}/participants/${bob.user.id}`).set(authHeader(alice.token));
    expect(forbidden.status).toBe(403);

    const removedEvent = nextEvent<{ channelId: string }>(bobConn.socket, 'conversation:removed');
    const updatedForAlice = nextEvent<{ id: string; participants: unknown[] }>(aliceConn.socket, 'conversation:updated');
    const res = await request(app).delete(`/api/channels/${channelId}/participants/${bob.user.id}`).set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(await removedEvent).toEqual({ channelId });
    expect((await updatedForAlice).participants).toHaveLength(2);

    const leaked = collect(bobConn.socket, 'message:received', 700);
    expect((await emitAck(ownerConn.socket, 'message:send', { channelId, content: 'after removal' })).ok).toBe(true);
    expect(await leaked).toHaveLength(0);
    expect((await request(app).get(`/api/channels/${channelId}/messages`).set(authHeader(bob.token))).status).toBe(403);
    expect((await emitAck(bobConn.socket, 'message:send', { channelId, content: 'still here?' })).ok).toBe(false);
  });

  it('anyone can leave; participants can rename', async () => {
    const { owner, alice, channelId } = await setup();
    const ownerConn = await harness.connect(owner);
    const renamed = nextEvent<{ id: string; name: string }>(ownerConn.socket, 'conversation:updated', (c) => c.name === 'Renamed');
    const rename = await request(app).patch(`/api/channels/${channelId}/conversation`).set(authHeader(alice.token)).send({ name: 'Renamed' });
    expect(rename.body.name).toBe('Renamed');
    await renamed;

    const leave = await request(app).delete(`/api/channels/${channelId}/participants/${alice.user.id}`).set(authHeader(alice.token));
    expect(leave.status).toBe(200);
    expect(await prisma.channelMember.count({ where: { channelId, userId: alice.user.id } })).toBe(0);
  });

  it('1:1 DMs have participants but cannot be extended or left this way', async () => {
    const { owner, people, workspaceId } = await team(2);
    const [alice, bob] = people;
    const dm = await createDM(owner, alice, workspaceId);
    const list = await request(app).get(`/api/channels/${dm.id}/participants`).set(authHeader(owner.token));
    expect(list.body.participants).toHaveLength(2);
    expect(
      (await request(app).post(`/api/channels/${dm.id}/participants`).set(authHeader(owner.token)).send({ userId: bob.user.id })).status
    ).toBe(400);
    expect((await request(app).delete(`/api/channels/${dm.id}/participants/${owner.user.id}`).set(authHeader(owner.token))).status).toBe(400);
  });
});
