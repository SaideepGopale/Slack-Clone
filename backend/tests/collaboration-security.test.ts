import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { isBlockedAddress } from '../modules/preview/safeFetch';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace, seedMessage } from './collab-helpers';

/**
 * Regression suite for the Batch 1 authorization fixes. Every test here
 * corresponds to an exploit path found in the 2026-11-04 audit.
 */

describe('identity-less tokens (SEC-01)', () => {
  // A token shaped exactly like the old reusable invite-link JWT: signed with
  // the session secret, but with no user id.
  const legacyLinkToken = (workspaceId: string) =>
    jwt.sign({ workspaceId }, process.env.JWT_SECRET as string, { expiresIn: '7d' });

  it('cannot be used to list other people\'s data on any collaboration route', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);
    const token = legacyLinkToken(workspaceId);

    const routes = [
      '/api/invitations',
      '/api/workspaces',
      '/api/channels',
      '/api/users',
      `/api/workspaces/${workspaceId}/dms`,
      `/api/workspaces/${workspaceId}/channels`,
    ];
    for (const route of routes) {
      const res = await request(app).get(route).set(authHeader(token));
      expect(res.status, route).toBe(401);
    }
  });

  it('new invite links are opaque, reusable, and are not accepted as session tokens', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);

    const first = await request(app).get(`/api/workspaces/${workspaceId}/invite-link`).set(authHeader(owner.token));
    const second = await request(app).get(`/api/workspaces/${workspaceId}/invite-link`).set(authHeader(owner.token));
    expect(first.status).toBe(200);
    expect(second.body.url).toBe(first.body.url);

    const linkToken = new URL(first.body.url).searchParams.get('token')!;
    expect(linkToken.split('.')).toHaveLength(1); // not a JWT
    const asSession = await request(app).get('/api/invitations').set(authHeader(linkToken));
    expect(asSession.status).not.toBe(200);
  });

  it('rejects expired and revoked invite links', async () => {
    const owner = await createAndLoginUser();
    const requester = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);
    const linkRes = await request(app).get(`/api/workspaces/${workspaceId}/invite-link`).set(authHeader(owner.token));
    const token = new URL(linkRes.body.url).searchParams.get('token')!;

    await prisma.workspaceInviteLink.update({ where: { token }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).post('/api/workspaces/join').set(authHeader(requester.token)).send({ token });
    expect(expired.status).toBe(400);

    await prisma.workspaceInviteLink.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date() },
    });
    const revoked = await request(app).post('/api/workspaces/join').set(authHeader(requester.token)).send({ token });
    expect(revoked.status).toBe(400);
  });

  it('still honours an already-issued legacy JWT invite link until it expires', async () => {
    const owner = await createAndLoginUser();
    const requester = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);

    const res = await request(app)
      .post('/api/workspaces/join')
      .set(authHeader(requester.token))
      .send({ token: legacyLinkToken(workspaceId) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending' });
  });

  it('a regular session JWT is not accepted as an invite link', async () => {
    const owner = await createAndLoginUser();
    const requester = await createAndLoginUser();
    await createWorkspace(owner);
    const res = await request(app).post('/api/workspaces/join').set(authHeader(requester.token)).send({ token: owner.token });
    expect(res.status).toBe(400);
  });
});

describe('direct-message privacy (SEC-03)', () => {
  const setup = async () => {
    const owner = await createAndLoginUser();
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const mallory = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    for (const u of [alice, bob, mallory]) await addToWorkspace(u, workspaceId, [generalChannelId]);
    const dm = await createDM(alice, bob, workspaceId);
    await seedMessage(dm.id, workspaceId, alice.user.id, '<p>secret plans</p>');
    return { owner, alice, bob, mallory, workspaceId, dm };
  };

  it('a workspace member cannot join someone else\'s DM or read it', async () => {
    const { mallory, dm } = await setup();
    const join = await request(app).post(`/api/channels/${dm.id}/join`).set(authHeader(mallory.token));
    expect(join.status).toBe(403);
    const read = await request(app).get(`/api/channels/${dm.id}/messages`).set(authHeader(mallory.token));
    expect(read.status).toBe(403);
    const membership = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId: mallory.user.id, channelId: dm.id } },
    });
    expect(membership).toBeNull();
  });

  it('nobody — not even a participant or workspace admin — can add a third person to a DM', async () => {
    const { owner, alice, mallory, dm } = await setup();
    for (const actor of [alice, owner]) {
      const res = await request(app)
        .post(`/api/channels/${dm.id}/members`)
        .set(authHeader(actor.token))
        .send({ userId: mallory.user.id });
      expect(res.status).toBe(403);
    }
    const addable = await request(app).get(`/api/channels/${dm.id}/addable-members`).set(authHeader(alice.token));
    expect(addable.status).toBe(403);
  });

  it('participants can read their DM', async () => {
    const { bob, dm } = await setup();
    const res = await request(app).get(`/api/channels/${dm.id}/messages`).set(authHeader(bob.token));
    expect(res.status).toBe(200);
    expect(res.body.messages[0].content).toContain('secret plans');
  });
});

describe('DM creation and listing', () => {
  it('validates the target user and never duplicates a conversation', async () => {
    const owner = await createAndLoginUser();
    const alice = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);
    await addToWorkspace(alice, workspaceId);

    const missing = await request(app).post('/api/channels/dm').set(authHeader(owner.token)).send({});
    expect(missing.status).toBe(400);
    const self = await request(app).post('/api/channels/dm').set(authHeader(owner.token)).send({ targetUserId: owner.user.id });
    expect(self.status).toBe(400);

    const first = await createDM(owner, alice, workspaceId);
    const again = await createDM(alice, owner, workspaceId);
    expect(again.id).toBe(first.id);
    expect(first.otherUserId).toBe(alice.user.id);
    expect(first.name).toBe(alice.user.username);
  });

  it('lists DMs most-recent-first with a plain-text preview of the last message', async () => {
    const owner = await createAndLoginUser();
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);
    await addToWorkspace(alice, workspaceId);
    await addToWorkspace(bob, workspaceId);

    const withAlice = await createDM(owner, alice, workspaceId);
    const withBob = await createDM(owner, bob, workspaceId);
    await seedMessage(withBob.id, workspaceId, bob.user.id, '<p>older &amp; quieter</p>', {
      createdAt: new Date(Date.now() - 60_000),
    });
    await seedMessage(withAlice.id, workspaceId, alice.user.id, '<p><strong>hello</strong> there</p>');

    const res = await request(app).get(`/api/workspaces/${workspaceId}/dms`).set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.map((d: { id: string }) => d.id)).toEqual([withAlice.id, withBob.id]);
    expect(res.body[0].lastMessage.preview).toBe('hello there');
    expect(res.body[1].lastMessage.preview).toBe('older & quieter');
    expect(res.body[0].otherUserId).toBe(alice.user.id);
  });
});

describe('thread and history scoping (SEC-05)', () => {
  it('a thread never returns replies that live in a different channel', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    const other = await createWorkspace(owner);
    const parent = await seedMessage(generalChannelId, workspaceId, owner.user.id, 'parent');
    await seedMessage(generalChannelId, workspaceId, owner.user.id, 'legit reply', { parentId: parent.id });
    // A reply row pointing at `parent` from a foreign channel — the shape the
    // old unvalidated message:send could create.
    await seedMessage(other.generalChannelId, other.workspaceId, owner.user.id, 'injected', { parentId: parent.id });

    const res = await request(app).get(`/api/messages/${parent.id}/thread`).set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.replies.map((r: { content: string }) => r.content)).toEqual(['legit reply']);
  });

  it('backfills messages newer than an anchor, in order, and rejects foreign anchors/cursors', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    const other = await createWorkspace(owner);
    const base = Date.now() - 10_000;
    const anchor = await seedMessage(generalChannelId, workspaceId, owner.user.id, 'm0', { createdAt: new Date(base) });
    await seedMessage(generalChannelId, workspaceId, owner.user.id, 'm1', { createdAt: new Date(base + 1000) });
    await seedMessage(generalChannelId, workspaceId, owner.user.id, 'm2', { createdAt: new Date(base + 2000) });
    const foreign = await seedMessage(other.generalChannelId, other.workspaceId, owner.user.id, 'x');

    const res = await request(app)
      .get(`/api/channels/${generalChannelId}/messages`)
      .query({ after: anchor.id })
      .set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual(['m1', 'm2']);
    expect(res.body.hasMore).toBe(false);

    const badAfter = await request(app)
      .get(`/api/channels/${generalChannelId}/messages`)
      .query({ after: foreign.id })
      .set(authHeader(owner.token));
    expect(badAfter.status).toBe(400);
    const badCursor = await request(app)
      .get(`/api/channels/${generalChannelId}/messages`)
      .query({ cursor: foreign.id })
      .set(authHeader(owner.token));
    expect(badCursor.status).toBe(400);
  });
});

describe('link previews (SEC-04)', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/preview').send({ url: 'https://example.com' });
    expect(res.status).toBe(401);
  });

  it('refuses internal, private, metadata and non-http targets', async () => {
    const { token } = await createAndLoginUser();
    const blocked = [
      'http://127.0.0.1/',
      'http://localhost/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://[::ffff:127.0.0.1]/',
      'ftp://example.com/file',
      'file:///etc/passwd',
      'http://user:pass@example.com/',
      'http://example.com:8080/',
    ];
    for (const url of blocked) {
      const res = await request(app).post('/api/preview').set(authHeader(token)).send({ url });
      expect(res.status, url).toBe(400);
    }
  });

  it('classifies addresses correctly', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('frozen authentication contract (regression)', () => {
  it('login still returns the same token claims and user shape', async () => {
    const { user } = await createAndLoginUser();
    const bcryptPassword = 'Password123!'; // set by createAndLoginUser
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: bcryptPassword });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.user).sort()).toEqual(['email', 'id', 'lastActiveWorkspaceId', 'role', 'username']);
    const claims = jwt.decode(res.body.token) as Record<string, number | string>;
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'id', 'role', 'username']);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(7 * 24 * 60 * 60);
  });
});
