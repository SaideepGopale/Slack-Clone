import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { extractMentions } from '../lib/notifications';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace, seedMessage, TestUser } from './collab-helpers';
import { collect, emitAck, nextEvent, useSocketHarness } from './socket-harness';

/**
 * P2 Phase I — @mentions and thread replies notify the people involved (only
 * members of the conversation), the Activity feed is per workspace, and
 * workspace search only ever returns messages from conversations the caller
 * belongs to.
 */
const harness = useSocketHarness();

const team = async () => {
  const owner = await createAndLoginUser();
  const alice = await createAndLoginUser();
  const bob = await createAndLoginUser();
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  await addToWorkspace(alice, workspaceId, [generalChannelId]);
  await addToWorkspace(bob, workspaceId, [generalChannelId]);
  return { owner, alice, bob, workspaceId, generalChannelId };
};

const feed = (user: TestUser, workspaceId: string) =>
  request(app).get(`/api/workspaces/${workspaceId}/notifications`).set(authHeader(user.token));

describe('extractMentions', () => {
  it('finds @usernames in rendered text, ignoring e-mail addresses and duplicates', () => {
    expect(extractMentions('<p>hey <strong>@Alice</strong> and @bob_2, ping @alice.</p>')).toEqual(['alice', 'bob_2']);
    expect(extractMentions('<p>mail bob@example.com</p>')).toEqual([]);
    expect(extractMentions('<p>@a @b</p>')).toEqual(['a', 'b']);
    expect(extractMentions(Array.from({ length: 40 }, (_, i) => `@user${i}`).join(' '))).toHaveLength(20);
  });
});

describe('mention and reply notifications (P2 Phase I)', () => {
  it('notifies mentioned members in real time and lists them in their workspace feed', async () => {
    const { owner, alice, bob, workspaceId, generalChannelId } = await team();
    const aliceConn = await harness.connect(alice);
    const bobConn = await harness.connect(bob);
    const ownerConn = await harness.connect(owner);

    const live = nextEvent<{ type: string; message: { preview: string }; channel: { id: string } }>(aliceConn.socket, 'notification:new');
    const bobHears = collect(bobConn.socket, 'notification:new', 1200);
    const sent = await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: `<p>hi @${alice.user.username}, see this</p>` });
    expect(sent.ok).toBe(true);

    const event = await live;
    expect(event).toMatchObject({ type: 'MENTION', channel: { id: generalChannelId } });
    expect(event.message.preview).toContain('see this');
    expect(await bobHears).toHaveLength(0);

    const res = await feed(alice, workspaceId);
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0]).toMatchObject({ type: 'MENTION', isRead: false, message: { sender: { id: owner.user.id } } });
    expect((await feed(bob, workspaceId)).body.notifications).toHaveLength(0);
  });

  it('never notifies people outside the conversation, or the sender', async () => {
    const { owner, alice, bob, workspaceId } = await team();
    const dm = await createDM(owner, alice, workspaceId);
    const outsider = await createAndLoginUser();
    const ownerConn = await harness.connect(owner);
    const content = `<p>@${bob.user.username} @${outsider.user.username} @${owner.user.username} secret</p>`;
    expect((await emitAck(ownerConn.socket, 'message:send', { channelId: dm.id, content })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    const rows = await prisma.notification.findMany({ where: { userId: { in: [bob.user.id, outsider.user.id, owner.user.id] } } });
    expect(rows).toHaveLength(0);
  });

  it("notifies a thread's author about replies, and the feed can be marked read", async () => {
    const { owner, alice, workspaceId, generalChannelId } = await team();
    const parent = await seedMessage(generalChannelId, workspaceId, alice.user.id, '<p>question</p>');
    const ownerConn = await harness.connect(owner);
    expect((await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: '<p>answer</p>', parentId: parent.id })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    const before = await feed(alice, workspaceId);
    expect(before.body.notifications.map((n: { type: string }) => n.type)).toEqual(['REPLY']);

    // Someone else can't mark Alice's notifications read.
    const id = before.body.notifications[0].id;
    await request(app).post(`/api/workspaces/${workspaceId}/notifications/read`).set(authHeader(owner.token)).send({ ids: [id] });
    expect((await feed(alice, workspaceId)).body.unreadCount).toBe(1);

    const mark = await request(app).post(`/api/workspaces/${workspaceId}/notifications/read`).set(authHeader(alice.token)).send({});
    expect(mark.status).toBe(200);
    expect((await feed(alice, workspaceId)).body.unreadCount).toBe(0);
  });

  it('keeps each workspace feed separate', async () => {
    const { owner, alice, workspaceId, generalChannelId } = await team();
    const other = await createWorkspace(owner);
    await addToWorkspace(alice, other.workspaceId, [other.generalChannelId]);
    const ownerConn = await harness.connect(owner);
    await emitAck(ownerConn.socket, 'message:send', { channelId: other.generalChannelId, content: `<p>@${alice.user.username} elsewhere</p>` });
    await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: `<p>@${alice.user.username} here</p>` });
    await new Promise((r) => setTimeout(r, 300));
    const here = (await feed(alice, workspaceId)).body.notifications.map((n: { message: { preview: string } }) => n.message.preview);
    expect(here).toHaveLength(1);
    expect(here[0]).toContain('here');
  });
});

describe('workspace search (P2 Phase I)', () => {
  const search = (user: TestUser, workspaceId: string, q: string) =>
    request(app).get(`/api/workspaces/${workspaceId}/search`).query({ q }).set(authHeader(user.token));

  it("returns matches from the caller's conversations only", async () => {
    const { owner, alice, bob, workspaceId, generalChannelId } = await team();
    const dm = await createDM(owner, alice, workspaceId);
    await seedMessage(generalChannelId, workspaceId, owner.user.id, '<p>launch plan public</p>');
    await seedMessage(dm.id, workspaceId, owner.user.id, '<p>launch plan secret</p>');

    const forAlice = await search(alice, workspaceId, 'launch plan');
    expect(forAlice.status).toBe(200);
    expect(forAlice.body.results.map((r: { channel: { id: string } }) => r.channel.id).sort()).toEqual([generalChannelId, dm.id].sort());

    const forBob = await search(bob, workspaceId, 'launch plan');
    expect(forBob.body.results.map((r: { channel: { id: string } }) => r.channel.id)).toEqual([generalChannelId]);
    expect(JSON.stringify(forBob.body)).not.toContain('secret');
  });

  it('refuses non-members and validates the query', async () => {
    const { owner, workspaceId, generalChannelId } = await team();
    await seedMessage(generalChannelId, workspaceId, owner.user.id, '<p>roadmap</p>');
    const outsider = await createAndLoginUser();
    expect((await search(outsider, workspaceId, 'roadmap')).status).toBe(403);
    expect((await search(owner, workspaceId, 'r')).status).toBe(400);
    expect((await search(owner, workspaceId, 'x'.repeat(201))).status).toBe(400);
  });
});
