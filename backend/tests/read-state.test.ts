import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace, seedMessage } from './collab-helpers';
import { collect, nextEvent, useSocketHarness } from './socket-harness';

const harness = useSocketHarness();

const unreadFor = async (token: string, workspaceId: string, channelId: string) => {
  const res = await request(app).get(`/api/workspaces/${workspaceId}/unread`).set(authHeader(token));
  expect(res.status).toBe(200);
  return res.body.channels.find((c: { channelId: string }) => c.channelId === channelId);
};

const markRead = (token: string, channelId: string, messageId?: string) =>
  request(app).post(`/api/channels/${channelId}/read`).set(authHeader(token)).send(messageId ? { messageId } : {});

const setupChannel = async () => {
  const owner = await createAndLoginUser();
  const member = await createAndLoginUser();
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  await addToWorkspace(member, workspaceId, [generalChannelId]);
  // Messages must be strictly newer than the membership's initial read position.
  const base = Date.now() + 1000;
  const msgs = [];
  for (let i = 0; i < 3; i += 1) {
    msgs.push(await seedMessage(generalChannelId, workspaceId, owner.user.id, `m${i}`, { createdAt: new Date(base + i * 1000) }));
  }
  return { owner, member, workspaceId, generalChannelId, msgs };
};

describe('persistent unread state', () => {
  it('counts top-level messages from others since the read position; persists across reloads', async () => {
    const { owner, member, workspaceId, generalChannelId, msgs } = await setupChannel();
    // Own messages and thread replies never count.
    await seedMessage(generalChannelId, workspaceId, member.user.id, 'mine', { createdAt: new Date(Date.now() + 5000) });
    await seedMessage(generalChannelId, workspaceId, owner.user.id, 'reply', {
      parentId: msgs[0].id,
      createdAt: new Date(Date.now() + 6000),
    });

    expect((await unreadFor(member.token, workspaceId, generalChannelId)).unreadCount).toBe(3);
    // The owner's own three messages don't count; the member's one does.
    expect((await unreadFor(owner.token, workspaceId, generalChannelId)).unreadCount).toBe(1);

    const res = await markRead(member.token, generalChannelId, msgs[1].id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ advanced: true, unreadCount: 1, lastReadMessageId: msgs[1].id });

    // "Reload": a fresh request reads the persisted position.
    expect(await unreadFor(member.token, workspaceId, generalChannelId)).toMatchObject({
      unreadCount: 1,
      lastReadMessageId: msgs[1].id,
    });
  });

  it('never moves backwards (stale tab/device) and converges under concurrent marks', async () => {
    const { member, generalChannelId, workspaceId, msgs } = await setupChannel();
    expect((await markRead(member.token, generalChannelId, msgs[2].id)).body.advanced).toBe(true);
    const stale = await markRead(member.token, generalChannelId, msgs[0].id);
    expect(stale.body).toMatchObject({ advanced: false, lastReadMessageId: msgs[2].id, unreadCount: 0 });

    const other = await setupChannel();
    await Promise.all(other.msgs.map((m) => markRead(other.member.token, other.generalChannelId, m.id)));
    const final = await unreadFor(other.member.token, other.workspaceId, other.generalChannelId);
    expect(final).toMatchObject({ lastReadMessageId: other.msgs[2].id, unreadCount: 0 });
    expect(workspaceId).toBeTruthy();
  });

  it('marks everything read when no messageId is given', async () => {
    const { member, generalChannelId, msgs } = await setupChannel();
    const res = await markRead(member.token, generalChannelId);
    expect(res.body).toMatchObject({ advanced: true, unreadCount: 0, lastReadMessageId: msgs[2].id });
  });

  it('caps very large backlogs', async () => {
    const owner = await createAndLoginUser();
    const member = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    await addToWorkspace(member, workspaceId, [generalChannelId]);
    const base = Date.now() + 1000;
    await prisma.message.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        channelId: generalChannelId,
        workspaceId,
        senderId: owner.user.id,
        content: `bulk ${i}`,
        createdAt: new Date(base + i),
      })),
    });
    expect((await unreadFor(member.token, workspaceId, generalChannelId)).unreadCount).toBe(100);
  });

  it('rejects foreign or invalid message ids, and non-members', async () => {
    const { member, generalChannelId } = await setupChannel();
    const elsewhere = await setupChannel();
    expect((await markRead(member.token, generalChannelId, elsewhere.msgs[0].id)).status).toBe(400);
    expect((await markRead(member.token, generalChannelId, 'not-a-uuid')).status).toBe(400);
    const outsider = await createAndLoginUser();
    expect((await markRead(outsider.token, generalChannelId)).status).toBe(403);
  });

  it('pushes the authoritative state to every device of the reader, once', async () => {
    const { member, generalChannelId, msgs } = await setupChannel();
    const tabA = await harness.connect(member);
    const tabB = await harness.connect(member);

    const onA = nextEvent<{ channelId: string; unreadCount: number }>(tabA.socket, 'read:updated');
    const onB = nextEvent<{ channelId: string; unreadCount: number }>(tabB.socket, 'read:updated');
    await markRead(member.token, generalChannelId, msgs[2].id);
    expect(await onA).toMatchObject({ channelId: generalChannelId, unreadCount: 0 });
    expect(await onB).toMatchObject({ channelId: generalChannelId, unreadCount: 0 });

    // A no-op mark (already at the newest position) emits nothing.
    const noise = collect(tabA.socket, 'read:updated', 500);
    await markRead(member.token, generalChannelId, msgs[1].id);
    expect(await noise).toHaveLength(0);
  });
});

describe('read receipts', () => {
  const setupDM = async () => {
    const owner = await createAndLoginUser();
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    await addToWorkspace(alice, workspaceId, [generalChannelId]);
    await addToWorkspace(bob, workspaceId, [generalChannelId]);
    const dm = await createDM(alice, bob, workspaceId);
    const msg = await seedMessage(dm.id, workspaceId, bob.user.id, 'hi alice', { createdAt: new Date(Date.now() + 1000) });
    return { owner, alice, bob, workspaceId, generalChannelId, dm, msg };
  };

  it('delivers receipts live and on demand to DM participants only', async () => {
    const { alice, bob, dm, msg } = await setupDM();
    const bobConn = await harness.connect(bob);
    const receipt = nextEvent<{ channelId: string; userId: string; lastReadMessageId: string }>(bobConn.socket, 'receipt:updated');
    await markRead(alice.token, dm.id, msg.id);
    expect(await receipt).toMatchObject({ channelId: dm.id, userId: alice.user.id, lastReadMessageId: msg.id });

    const res = await request(app).get(`/api/channels/${dm.id}/read-receipts`).set(authHeader(bob.token));
    expect(res.body.enabled).toBe(true);
    expect(res.body.receipts).toEqual([expect.objectContaining({ userId: alice.user.id, lastReadMessageId: msg.id })]);

    const outsider = await createAndLoginUser();
    expect((await request(app).get(`/api/channels/${dm.id}/read-receipts`).set(authHeader(outsider.token))).status).toBe(403);
  });

  it('is reciprocal and respects the opt-out', async () => {
    const { alice, bob, dm, msg } = await setupDM();
    const off = await request(app).patch('/api/users/me/profile').set(authHeader(alice.token)).send({ readReceiptsEnabled: false });
    expect(off.body.readReceiptsEnabled).toBe(false);

    const bobConn = await harness.connect(bob);
    const leaked = collect(bobConn.socket, 'receipt:updated', 600);
    await markRead(alice.token, dm.id, msg.id);
    expect(await leaked).toHaveLength(0);

    const bobView = await request(app).get(`/api/channels/${dm.id}/read-receipts`).set(authHeader(bob.token));
    expect(bobView.body.receipts.map((r: { userId: string }) => r.userId)).not.toContain(alice.user.id);
    const aliceView = await request(app).get(`/api/channels/${dm.id}/read-receipts`).set(authHeader(alice.token));
    expect(aliceView.body).toMatchObject({ enabled: false, reason: 'disabled', receipts: [] });
  });

  it('is never available in channels', async () => {
    const { alice, generalChannelId } = await setupDM();
    const res = await request(app).get(`/api/channels/${generalChannelId}/read-receipts`).set(authHeader(alice.token));
    expect(res.body).toMatchObject({ enabled: false, reason: 'not_a_conversation', receipts: [] });
  });
});

describe('profile & preferences', () => {
  it('validates and persists profile fields outside the auth tables', async () => {
    const { token, user } = await createAndLoginUser();
    for (const bad of [{ timezone: 'Mars/Olympus' }, { title: 'x'.repeat(81) }, { readReceiptsEnabled: 'yes' }]) {
      expect((await request(app).patch('/api/users/me/profile').set(authHeader(token)).send(bad)).status).toBe(400);
    }
    const ok = await request(app)
      .patch('/api/users/me/profile')
      .set(authHeader(token))
      .send({ title: 'Staff Engineer', bio: 'Builds things', timezone: 'Asia/Kolkata' });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/users/me/profile').set(authHeader(token))).body).toEqual({
      title: 'Staff Engineer',
      bio: 'Builds things',
      timezone: 'Asia/Kolkata',
      readReceiptsEnabled: true,
    });
    // The authentication row is untouched.
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row?.updatedAt.getTime()).toBe(user.updatedAt.getTime());
  });

  it('GET /api/users only lists people who share a workspace with the caller', async () => {
    const owner = await createAndLoginUser();
    const teammate = await createAndLoginUser();
    const stranger = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);
    await addToWorkspace(teammate, workspaceId);
    await createWorkspace(stranger);
    const res = await request(app).get('/api/users').set(authHeader(owner.token));
    const ids = res.body.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([owner.user.id, teammate.user.id]));
    expect(ids).not.toContain(stranger.user.id);
  });
});

describe('read-position privacy (regression)', () => {
  const PRIVATE_FIELDS = /lastReadAt|lastReadMessageId|historyFrom/;

  it('never exposes members\' read positions through listings, responses or conversation events', async () => {
    const owner = await createAndLoginUser();
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    await addToWorkspace(alice, workspaceId, [generalChannelId]);
    await addToWorkspace(bob, workspaceId, [generalChannelId]);
    await markRead(alice.token, generalChannelId);

    const aliceConn = await harness.connect(alice);
    const dmEvent = nextEvent(aliceConn.socket, 'dm:created');
    const dmRes = await request(app).post('/api/channels/dm').set(authHeader(owner.token)).send({ targetUserId: alice.user.id, workspaceId });
    const groupRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/group-dms`)
      .set(authHeader(owner.token))
      .send({ userIds: [alice.user.id, bob.user.id] });
    const added = await request(app)
      .post('/api/channels')
      .set(authHeader(owner.token))
      .send({ workspaceId, name: `priv-${Date.now()}` });
    const memberAdd = await request(app)
      .post(`/api/channels/${added.body.id}/members`)
      .set(authHeader(owner.token))
      .send({ userId: alice.user.id });

    const bodies = [
      dmRes.body,
      groupRes.body,
      memberAdd.body,
      await dmEvent,
      (await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(owner.token))).body,
      (await request(app).get(`/api/workspaces/${workspaceId}/dms`).set(authHeader(owner.token))).body,
      (await request(app).get('/api/channels').set(authHeader(owner.token))).body,
    ];
    for (const body of bodies) expect(JSON.stringify(body)).not.toMatch(PRIVATE_FIELDS);
  });
});
