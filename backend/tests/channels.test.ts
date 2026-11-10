import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace, seedMessage, TestUser } from './collab-helpers';
import { collect, emitAck, nextEvent, useSocketHarness } from './socket-harness';

/**
 * Sub-batch D — channel types and management: public/private/announcement,
 * settings, archive, roles, privacy-aware names, cross-workspace isolation,
 * search/unread privacy, real-time audiences and revocation.
 */

const harness = useSocketHarness();

const api = (user: TestUser) => ({
  get: (url: string) => request(app).get(url).set(authHeader(user.token)),
  post: (url: string, body: object = {}) => request(app).post(url).set(authHeader(user.token)).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set(authHeader(user.token)).send(body),
  del: (url: string) => request(app).delete(url).set(authHeader(user.token)),
});

/** owner = workspace owner (manager); alice, bob, carol = workspace members; outsider elsewhere. */
const setup = async () => {
  const [owner, alice, bob, carol, outsider] = await Promise.all([
    createAndLoginUser(),
    createAndLoginUser(),
    createAndLoginUser(),
    createAndLoginUser(),
    createAndLoginUser(),
  ]);
  const ws = await createWorkspace(owner);
  for (const user of [alice, bob, carol]) await addToWorkspace(user, ws.workspaceId, [ws.generalChannelId]);
  return { owner, alice, bob, carol, outsider, ...ws };
};

type ChannelBody = { id: string; name: string; visibility: string; isAnnouncement: boolean; type: string; archived?: boolean };

const newChannel = async (user: TestUser, workspaceId: string, extra: object = {}): Promise<ChannelBody> => {
  const res = await api(user).post('/api/channels', { workspaceId, name: `ch-${Math.random().toString(36).slice(2, 9)}`, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

const addMember = async (actor: TestUser, channelId: string, user: TestUser) => {
  const res = await api(actor).post(`/api/channels/${channelId}/members`, { userId: user.user.id });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

const setRole = (actor: TestUser, channelId: string, user: TestUser, role: string) =>
  api(actor).patch(`/api/channels/${channelId}/members/${user.user.id}`, { role });

const roleOf = async (channelId: string, user: TestUser) =>
  (await prisma.channelMember.findUnique({ where: { userId_channelId: { userId: user.user.id, channelId } } }))?.role ?? null;

const NOT_FOUND = { error: 'Channel not found.' };

describe('channel types', () => {
  it('creates public (default), private and announcement channels; existing channels stay public and open', async () => {
    const { owner, alice, workspaceId, generalChannelId } = await setup();
    const plain = await newChannel(alice, workspaceId);
    expect(plain).toMatchObject({ visibility: 'PUBLIC', isAnnouncement: false });
    const secret = await newChannel(alice, workspaceId, { visibility: 'PRIVATE' });
    expect(secret.visibility).toBe('PRIVATE');
    const news = await newChannel(alice, workspaceId, { isAnnouncement: true, topic: 'Company news' });
    expect(news).toMatchObject({ visibility: 'PUBLIC', isAnnouncement: true, topic: 'Company news' });
    expect((await api(alice).get(`/api/channels/${news.id}/details`)).body).toMatchObject({ type: 'ANNOUNCEMENT', myRole: 'admin' });

    const url = '/api/channels';
    expect((await api(alice).post(url, { workspaceId, name: 'x1', visibility: 'SECRET' })).status).toBe(400);
    expect((await api(alice).post(url, { workspaceId, name: 'x2', isAnnouncement: 'yes' })).status).toBe(400);
    expect((await api(alice).post(url, { workspaceId, name: 'x3', topic: 't'.repeat(251) })).status).toBe(400);

    const general = await api(owner).get(`/api/channels/${generalChannelId}/details`);
    expect(general.body).toMatchObject({ visibility: 'PUBLIC', isAnnouncement: false, archived: false, isGeneral: true, type: 'PUBLIC' });
  });
});

describe('discovery and private-channel isolation', () => {
  it('public channels are discoverable; private ones are invisible to non-members on every surface', async () => {
    const { owner, alice, bob, workspaceId } = await setup();
    const open = await newChannel(alice, workspaceId, { name: 'open-roadmap' });
    const secret = await newChannel(alice, workspaceId, { name: 'falcon-secret', visibility: 'PRIVATE' });
    await seedMessage(secret.id, workspaceId, alice.user.id, '<p>launch codes</p>');

    const bobBrowse = await api(bob).get(`/api/channels/all?workspaceId=${workspaceId}`);
    expect(bobBrowse.body.map((c: ChannelBody) => c.id)).toContain(open.id);
    expect(JSON.stringify(bobBrowse.body)).not.toContain('falcon-secret');
    expect((await api(bob).get(`/api/channels/${open.id}/details`)).body).toMatchObject({ myRole: null, capabilities: { canJoin: true, canRead: false } });

    const missing = '00000000-0000-4000-8000-000000000000';
    for (const path of ['details', 'members']) {
      const res = await api(bob).get(`/api/channels/${secret.id}/${path}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    expect((await api(bob).post(`/api/channels/${secret.id}/join`)).status).toBe(404);
    expect((await api(bob).patch(`/api/channels/${secret.id}`, { topic: 'x' })).status).toBe(404);
    expect((await api(bob).post(`/api/channels/${secret.id}/archive`)).status).toBe(404);
    // Content endpoints answer exactly like a channel that doesn't exist.
    for (const path of ['messages', 'search?q=launch']) {
      const hidden = await api(bob).get(`/api/channels/${secret.id}/${path}`);
      const absent = await api(bob).get(`/api/channels/${missing}/${path}`);
      expect(hidden.status).toBe(absent.status);
      expect(hidden.body).toEqual(absent.body);
      expect(JSON.stringify(hidden.body)).not.toContain('launch codes');
    }
    expect(JSON.stringify((await api(bob).get(`/api/workspaces/${workspaceId}/unread`)).body)).not.toContain(secret.id);
    const count = async (u: TestUser) =>
      (await api(u).get('/api/workspaces')).body.find((w: { id: string }) => w.id === workspaceId)._count.channels;
    expect(await count(alice)).toBe(3); // General, open, secret
    expect(await count(bob)).toBe(2);

    // Members see it; the workspace manager sees its metadata but no content.
    expect((await api(alice).get(`/api/channels/all?workspaceId=${workspaceId}`)).body.map((c: ChannelBody) => c.id)).toContain(secret.id);
    const managerBrowse = await api(owner).get(`/api/channels/all?workspaceId=${workspaceId}`);
    expect(managerBrowse.body.find((c: ChannelBody & { isMember: boolean }) => c.id === secret.id)).toMatchObject({ isMember: false });
    const managerView = await api(owner).get(`/api/channels/${secret.id}/details`);
    expect(managerView.body).toMatchObject({ myRole: null, capabilities: { canRead: false, canUpdateSettings: true, canJoin: false } });
    expect((await api(owner).get(`/api/channels/${secret.id}/messages`)).status).toBe(403);
    expect((await api(owner).post(`/api/channels/${secret.id}/join`)).status).toBe(403);
    expect((await api(owner).post(`/api/channels/${secret.id}/members`, { userId: owner.user.id })).status).toBe(403);
  });

  it('a public channel inside a private project is hidden from non-project members', async () => {
    const { alice, bob, workspaceId } = await setup();
    const project = await api(alice).post(`/api/workspaces/${workspaceId}/projects`, { name: 'Stealth', visibility: 'PRIVATE' });
    const channel = await newChannel(alice, workspaceId, { name: 'stealth-public', projectId: project.body.id });
    expect((await api(bob).get(`/api/channels/${channel.id}/details`)).status).toBe(404);
    expect(JSON.stringify((await api(bob).get(`/api/channels/all?workspaceId=${workspaceId}`)).body)).not.toContain('stealth-public');
  });
});

describe('announcement channels', () => {
  it('only owners, moderators and member-admins post top-level; everyone replies and reacts (sockets + REST)', async () => {
    const { owner, alice, bob, carol, workspaceId } = await setup();
    const news = await newChannel(alice, workspaceId, { isAnnouncement: true });
    for (const u of [bob, carol, owner]) await addMember(alice, news.id, u);
    expect((await setRole(alice, news.id, carol, 'moderator')).status).toBe(200);
    const [aliceConn, bobConn, carolConn, ownerConn] = await Promise.all([alice, bob, carol, owner].map(harness.connect));

    const leaked = collect(aliceConn.socket, 'message:received', 700);
    const denied = await emitAck(bobConn.socket, 'message:send', { channelId: news.id, content: 'hello all' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/announcement/);
    expect(await leaked).toHaveLength(0);

    const post = await emitAck(aliceConn.socket, 'message:send', { channelId: news.id, content: 'Quarterly update' });
    expect(post.ok).toBe(true);
    expect((await emitAck(carolConn.socket, 'message:send', { channelId: news.id, content: 'Moderator note' })).ok).toBe(true);
    // Workspace owner is a member here → may post as a workspace manager.
    expect((await emitAck(ownerConn.socket, 'message:send', { channelId: news.id, content: 'Admin note' })).ok).toBe(true);

    const reply = await emitAck(bobConn.socket, 'message:send', { channelId: news.id, content: 'Thanks!', parentId: post.message!.id });
    expect(reply.ok).toBe(true);
    const react = await api(bob).post(`/api/messages/${post.message!.id}/reactions`, { emoji: '🎉' });
    expect(react.status).toBe(200);
    expect(await prisma.message.count({ where: { channelId: news.id, senderId: bob.user.id, parentId: null } })).toBe(0);

    // Turning announcement mode off restores open posting.
    expect((await api(alice).patch(`/api/channels/${news.id}`, { isAnnouncement: false })).status).toBe(200);
    expect((await emitAck(bobConn.socket, 'message:send', { channelId: news.id, content: 'now open' })).ok).toBe(true);
  });
});

describe('membership and roles', () => {
  it('private channels: owner/moderators/managers manage membership; members cannot', async () => {
    const { owner, alice, bob, carol, workspaceId } = await setup();
    const secret = await newChannel(alice, workspaceId, { visibility: 'PRIVATE' });
    await addMember(alice, secret.id, bob);
    expect((await api(bob).post(`/api/channels/${secret.id}/members`, { userId: carol.user.id })).status).toBe(403);
    expect((await setRole(alice, secret.id, bob, 'moderator')).status).toBe(200);
    await addMember(bob, secret.id, carol);
    expect((await api(owner).get(`/api/channels/${secret.id}/addable-members`)).body.map((u: { id: string }) => u.id)).not.toContain(owner.user.id);

    // Search by bob's unique suffix (usernames are `user_<8 hex>`), case-insensitively.
    const members = await api(carol).get(`/api/channels/${secret.id}/members?q=${bob.user.username.slice(5).toUpperCase()}`);
    expect(members.body.members).toEqual([expect.objectContaining({ userId: bob.user.id, role: 'moderator' })]);
    expect(JSON.stringify(members.body)).not.toMatch(/lastReadAt|lastReadMessageId|historyFrom|email/);

    // Removal: moderators remove members only; nobody removes the owner; managers needn't be members.
    expect((await api(carol).del(`/api/channels/${secret.id}/members/${bob.user.id}`)).status).toBe(403);
    expect((await setRole(alice, secret.id, carol, 'moderator')).status).toBe(200);
    expect((await api(bob).del(`/api/channels/${secret.id}/members/${carol.user.id}`)).status).toBe(403); // moderator vs moderator
    expect((await setRole(alice, secret.id, carol, 'member')).status).toBe(200);
    expect((await api(bob).del(`/api/channels/${secret.id}/members/${alice.user.id}`)).status).toBe(400);
    expect((await api(owner).del(`/api/channels/${secret.id}/members/${alice.user.id}`)).status).toBe(400);
    expect((await api(bob).del(`/api/channels/${secret.id}/members/${bob.user.id}`)).status).toBe(400);
    expect((await api(bob).del(`/api/channels/${secret.id}/members/${carol.user.id}`)).status).toBe(200);
    expect((await api(owner).del(`/api/channels/${secret.id}/members/${bob.user.id}`)).status).toBe(200);
    expect(await prisma.channelMember.count({ where: { channelId: secret.id } })).toBe(1);
  });

  it('role changes: no self-escalation, single owner by transfer, invalid roles refused', async () => {
    const { owner, alice, bob, carol, outsider, workspaceId } = await setup();
    const channel = await newChannel(alice, workspaceId);
    for (const u of [bob, carol]) await addMember(alice, channel.id, u);

    expect((await setRole(bob, channel.id, bob, 'admin')).status).toBe(403); // member → no role power at all
    expect((await setRole(alice, channel.id, bob, 'moderator')).status).toBe(200);
    expect((await setRole(bob, channel.id, bob, 'admin')).status).toBe(403); // moderator can't self-promote
    expect((await setRole(bob, channel.id, carol, 'moderator')).status).toBe(403); // or promote others
    expect((await setRole(alice, channel.id, alice, 'member')).status).toBe(400); // owner can't self-demote
    expect((await setRole(alice, channel.id, carol, 'superuser')).status).toBe(400);
    expect((await setRole(alice, channel.id, outsider, 'moderator')).status).toBe(404);

    // Transfer: exactly one owner; the previous owner becomes a moderator.
    const transfer = await setRole(alice, channel.id, carol, 'admin');
    expect(transfer.status).toBe(200);
    expect(transfer.body).toMatchObject({ userId: carol.user.id, role: 'admin' });
    expect(await prisma.channelMember.count({ where: { channelId: channel.id, role: 'admin' } })).toBe(1);
    expect(await roleOf(channel.id, alice)).toBe('moderator');
    expect((await setRole(owner, channel.id, carol, 'member')).status).toBe(400); // owner changes only by transfer
    expect((await setRole(owner, channel.id, bob, 'member')).status).toBe(200); // managers manage roles
    expect(await prisma.auditLog.count({ where: { targetId: channel.id, action: { in: ['TRANSFER_CHANNEL_OWNERSHIP', 'CHANGE_CHANNEL_ROLE'] } } })).toBe(3);

    // The owner leaves only after transferring.
    expect((await api(carol).post(`/api/channels/${channel.id}/leave`)).status).toBe(400);
    expect((await setRole(carol, channel.id, alice, 'admin')).status).toBe(200);
    expect((await api(carol).post(`/api/channels/${channel.id}/leave`)).status).toBe(200);
  });
});

describe('settings and archiving', () => {
  it('topic/description for staff; name and type for owner/managers; General keeps name and type', async () => {
    const { owner, alice, bob, carol, workspaceId, generalChannelId } = await setup();
    const channel = await newChannel(alice, workspaceId);
    for (const u of [bob, carol]) await addMember(alice, channel.id, u);
    await setRole(alice, channel.id, bob, 'moderator');

    expect((await api(carol).patch(`/api/channels/${channel.id}`, { topic: 'x' })).status).toBe(403);
    expect((await api(bob).patch(`/api/channels/${channel.id}`, { topic: 'Ship it', description: 'Release work' })).status).toBe(200);
    expect((await api(bob).patch(`/api/channels/${channel.id}`, { name: 'renamed' })).status).toBe(403);
    const renamed = await api(alice).patch(`/api/channels/${channel.id}`, { name: 'release-train', visibility: 'PRIVATE' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'release-train', visibility: 'PRIVATE', topic: 'Ship it', description: 'Release work' });
    expect((await api(alice).patch(`/api/channels/${channel.id}`, {})).status).toBe(400);

    for (const body of [{ name: 'lobby' }, { visibility: 'PRIVATE' }, { isAnnouncement: true }]) {
      expect((await api(owner).patch(`/api/channels/${generalChannelId}`, body)).status).toBe(400);
    }
    expect((await api(owner).patch(`/api/channels/${generalChannelId}`, { topic: 'Say hi' })).status).toBe(200);
    expect((await api(owner).post(`/api/channels/${generalChannelId}/archive`)).status).toBe(400);
  });

  it('archived channels are read-only, undiscoverable and fully preserved; restore re-opens them', async () => {
    const { owner, alice, bob, carol, workspaceId } = await setup();
    const channel = await newChannel(alice, workspaceId, { name: 'old-project' });
    await addMember(alice, channel.id, bob);
    const [aliceConn, bobConn] = await Promise.all([harness.connect(alice), harness.connect(bob)]);
    const first = await emitAck(aliceConn.socket, 'message:send', { channelId: channel.id, content: 'history matters' });
    const poll = await prisma.message.create({
      data: {
        channelId: channel.id,
        workspaceId,
        senderId: alice.user.id,
        content: '',
        pollData: { question: 'Lunch?', options: [{ id: 'opt-0', text: 'Yes', votes: [] }] },
      },
    });
    const before = { messages: await prisma.message.count({ where: { channelId: channel.id } }), members: await prisma.channelMember.count({ where: { channelId: channel.id } }) };

    expect((await api(bob).post(`/api/channels/${channel.id}/archive`)).status).toBe(403);
    const archived = await api(alice).post(`/api/channels/${channel.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: true, archivedBy: { id: alice.user.id }, capabilities: { canPost: false, canRead: true } });

    const msgId = first.message!.id;
    for (const [event, payload] of [
      ['message:send', { channelId: channel.id, content: 'late' }],
      ['message:send', { channelId: channel.id, content: 'late reply', parentId: msgId }],
      ['message:edit', { id: msgId, content: 'rewritten' }],
      ['message:delete', { id: msgId }],
      ['message:pin', { id: msgId, isPinned: true }],
      ['poll:vote', { messageId: poll.id, optionId: 'opt-0' }],
    ] as const) {
      const ack = await emitAck(aliceConn.socket, event, payload);
      expect(ack.ok, event).toBe(false);
      expect(ack.error, event).toMatch(/archived/);
    }
    expect((await api(bob).post(`/api/messages/${msgId}/reactions`, { emoji: '👍' })).status).toBe(409);
    expect((await api(carol).post(`/api/channels/${channel.id}/join`)).status).toBe(409);
    expect((await api(alice).post(`/api/channels/${channel.id}/members`, { userId: carol.user.id })).status).toBe(409);
    expect((await api(alice).patch(`/api/channels/${channel.id}`, { topic: 'x' })).status).toBe(409);

    // History stays readable and searchable; nothing was deleted.
    expect((await api(bob).get(`/api/channels/${channel.id}/messages`)).body.messages.map((m: { content: string }) => m.content)).toContain('history matters');
    expect((await api(bob).get(`/api/channels/${channel.id}/search?q=history`)).body.length).toBe(1);
    expect(await prisma.message.count({ where: { channelId: channel.id } })).toBe(before.messages);
    expect(await prisma.channelMember.count({ where: { channelId: channel.id } })).toBe(before.members);
    // Out of normal discovery; still listed under ?archived=true and in members' own lists.
    expect((await api(carol).get(`/api/channels/all?workspaceId=${workspaceId}`)).body.map((c: ChannelBody) => c.id)).not.toContain(channel.id);
    expect((await api(carol).get(`/api/channels/all?workspaceId=${workspaceId}&archived=true`)).body.map((c: ChannelBody) => c.id)).toContain(channel.id);
    expect((await api(bob).get(`/api/workspaces/${workspaceId}/channels`)).body.find((c: { id: string }) => c.id === channel.id).archivedAt).toBeTruthy();
    // Members can still leave and be removed.
    expect((await api(bob).post(`/api/channels/${channel.id}/leave`)).status).toBe(200);

    const restored = await api(owner).post(`/api/channels/${channel.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);
    expect((await emitAck(aliceConn.socket, 'message:send', { channelId: channel.id, content: 'back again' })).ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { targetId: channel.id, action: { in: ['ARCHIVE_CHANNEL', 'RESTORE_CHANNEL'] } } })).toBe(2);
    void bobConn;
  });
});

describe('privacy-aware channel names', () => {
  it('duplicates are refused only against channels the requester can see', async () => {
    const { owner, alice, bob, workspaceId } = await setup();
    await newChannel(alice, workspaceId, { name: 'design' });
    const dup = await api(bob).post('/api/channels', { workspaceId, name: 'DESIGN' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('A channel named "DESIGN" already exists in this workspace.');

    // A private channel bob can't see never blocks him and is never mentioned.
    await newChannel(alice, workspaceId, { name: 'acquisition-x', visibility: 'PRIVATE' });
    const bobsOwn = await api(bob).post('/api/channels', { workspaceId, name: 'Acquisition-X' });
    expect(bobsOwn.status).toBe(201);
    // …but blocks those who can see it: its member, and the workspace manager.
    expect((await api(alice).post('/api/channels', { workspaceId, name: 'acquisition-x', visibility: 'PRIVATE' })).status).toBe(409);
    expect((await api(owner).post('/api/channels', { workspaceId, name: 'ACQUISITION-X' })).status).toBe(409);

    // Same for a channel inside a private project.
    const project = await api(alice).post(`/api/workspaces/${workspaceId}/projects`, { name: 'P', visibility: 'PRIVATE' });
    await newChannel(alice, workspaceId, { name: 'hidden-in-project', projectId: project.body.id });
    expect((await api(bob).post('/api/channels', { workspaceId, name: 'hidden-in-project' })).status).toBe(201);

    // Renames and private → public re-check against what the requester sees.
    const mine = await newChannel(bob, workspaceId, { name: 'bob-notes' });
    expect((await api(bob).patch(`/api/channels/${mine.id}`, { name: 'Design' })).status).toBe(409);
    const quiet = await newChannel(alice, workspaceId, { name: 'quiet', visibility: 'PRIVATE' });
    await newChannel(bob, workspaceId, { name: 'Quiet' }); // bob can't see alice's private one
    expect((await api(alice).patch(`/api/channels/${quiet.id}`, { visibility: 'PUBLIC' })).status).toBe(409);
  });

  it('concurrent creates of the same name produce exactly one channel', async () => {
    const { alice, bob, workspaceId } = await setup();
    const results = await Promise.all([alice, bob, alice, bob].map((u) => api(u).post('/api/channels', { workspaceId, name: 'race-condition' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await prisma.channel.count({ where: { workspaceId, name: { equals: 'race-condition', mode: 'insensitive' } } })).toBe(1);
  });
});

describe('cross-workspace isolation, General, DMs and group DMs', () => {
  it('channels of another workspace are unreachable', async () => {
    const { alice, outsider, workspaceId } = await setup();
    const otherOwner = await createAndLoginUser();
    const other = await createWorkspace(otherOwner);
    const foreign = await newChannel(otherOwner, other.workspaceId);
    for (const res of [
      await api(alice).get(`/api/channels/${foreign.id}/details`),
      await api(alice).get(`/api/channels/${foreign.id}/members`),
      await api(alice).patch(`/api/channels/${foreign.id}`, { topic: 'x' }),
      await api(alice).post(`/api/channels/${foreign.id}/archive`),
      await setRole(alice, foreign.id, otherOwner, 'member'),
      await api(alice).del(`/api/channels/${foreign.id}/members/${otherOwner.user.id}`),
    ]) {
      expect(res.status).toBe(404);
    }
    const local = await newChannel(alice, workspaceId);
    expect((await api(alice).post(`/api/channels/${local.id}/members`, { userId: outsider.user.id })).status).toBe(400);
    expect((await api(otherOwner).post(`/api/channels/${local.id}/join`)).status).toBe(403);
  });

  it('DMs and group DMs keep working and never become managed channels', async () => {
    const { alice, bob, carol, workspaceId } = await setup();
    const dm = await createDM(alice, bob, workspaceId);
    const group = await api(alice).post(`/api/workspaces/${workspaceId}/group-dms`, { userIds: [bob.user.id, carol.user.id] });
    expect(group.status).toBe(201);
    for (const id of [dm.id, group.body.id]) {
      expect((await api(alice).get(`/api/channels/${id}/details`)).status).toBe(400);
      expect((await api(alice).patch(`/api/channels/${id}`, { visibility: 'PUBLIC', isAnnouncement: true })).status).toBe(400);
      expect((await api(alice).post(`/api/channels/${id}/archive`)).status).toBe(400);
      expect((await api(alice).post(`/api/channels/${id}/members`, { userId: carol.user.id })).status).toBe(403);
    }
    expect((await api(carol).get(`/api/channels/${dm.id}/details`)).status).toBe(404);
    const [aliceConn, bobConn] = await Promise.all([harness.connect(alice), harness.connect(bob)]);
    const got = nextEvent<{ content: string }>(bobConn.socket, 'message:received', (m) => m.content === 'dm still works');
    expect((await emitAck(aliceConn.socket, 'message:send', { channelId: dm.id, content: 'dm still works' })).ok).toBe(true);
    await got;
    expect((await emitAck(aliceConn.socket, 'message:send', { channelId: group.body.id, content: 'group too' })).ok).toBe(true);
  });
});

describe('real-time channel events', () => {
  it('private-channel events reach members and managers only; public updates reach the workspace', async () => {
    const { owner, alice, bob, carol, workspaceId } = await setup();
    const secret = await newChannel(alice, workspaceId, { name: 'war-room', visibility: 'PRIVATE' });
    await addMember(alice, secret.id, bob);
    const [, bobConn, carolConn, ownerConn] = await Promise.all([alice, bob, carol, owner].map(harness.connect));

    const bobSees = nextEvent<{ channel: { id: string; topic: string } }>(bobConn.socket, 'channel:updated');
    const ownerSees = nextEvent<{ channel: { id: string } }>(ownerConn.socket, 'channel:updated');
    const carolLeak = Promise.all(['channel:updated', 'channel:members_changed', 'channel:removed'].map((e) => collect(carolConn.socket, e, 800)));
    expect((await api(alice).patch(`/api/channels/${secret.id}`, { topic: 'Incident 42' })).status).toBe(200);
    expect((await bobSees).channel).toMatchObject({ id: secret.id, topic: 'Incident 42' });
    expect((await ownerSees).channel.id).toBe(secret.id);
    const roleEvent = nextEvent<{ change: string; member: { userId: string; role: string } }>(bobConn.socket, 'channel:members_changed');
    expect((await setRole(alice, secret.id, bob, 'moderator')).status).toBe(200);
    expect((await roleEvent).member).toMatchObject({ userId: bob.user.id, role: 'moderator' });
    expect((await carolLeak).flat()).toHaveLength(0);

    // Public channel: the whole workspace hears updates; going private drops it for non-members.
    const open = await newChannel(alice, workspaceId, { name: 'town-hall' });
    await addMember(alice, open.id, bob);
    const carolUpdate = nextEvent<{ channel: { id: string } }>(carolConn.socket, 'channel:updated', (p) => p.channel.id === open.id);
    expect((await api(alice).patch(`/api/channels/${open.id}`, { description: 'All hands' })).status).toBe(200);
    await carolUpdate;
    const carolDrop = nextEvent<{ channelId: string }>(carolConn.socket, 'channel:removed');
    const bobNoDrop = collect(bobConn.socket, 'channel:removed', 700);
    const bobUpdate = nextEvent<{ channel: { visibility: string } }>(bobConn.socket, 'channel:updated', (p) => p.channel.visibility === 'PRIVATE');
    expect((await api(alice).patch(`/api/channels/${open.id}`, { visibility: 'PRIVATE' })).status).toBe(200);
    expect((await carolDrop).channelId).toBe(open.id);
    await bobUpdate;
    expect(await bobNoDrop).toHaveLength(0);
  });

  it('removal from a private channel revokes its room immediately', async () => {
    const { alice, bob, workspaceId } = await setup();
    const secret = await newChannel(alice, workspaceId, { visibility: 'PRIVATE' });
    await addMember(alice, secret.id, bob);
    const [aliceConn, bobConn] = await Promise.all([harness.connect(alice), harness.connect(bob)]);
    expect(bobConn.channelIds).toContain(secret.id);

    const removed = nextEvent<{ channelId: string }>(bobConn.socket, 'conversation:removed');
    expect((await api(alice).del(`/api/channels/${secret.id}/members/${bob.user.id}`)).status).toBe(200);
    expect((await removed).channelId).toBe(secret.id);
    const leaked = collect(bobConn.socket, 'message:received', 700);
    expect((await emitAck(aliceConn.socket, 'message:send', { channelId: secret.id, content: 'after removal' })).ok).toBe(true);
    expect(await leaked).toHaveLength(0);
    expect((await emitAck(bobConn.socket, 'message:send', { channelId: secret.id, content: 'still here?' })).ok).toBe(false);
    expect((await api(bob).get(`/api/channels/${secret.id}/details`)).status).toBe(404);
  });
});
