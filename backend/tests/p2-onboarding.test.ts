import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, grantTier } from './helpers';
import { emitAck, nextEvent, useSocketHarness } from './socket-harness';

/**
 * P2 — the primary business flow, through the real API:
 *  platform admin provisions accounts (no e-mail / OTP / link) → users log in
 *  → a user creates a workspace and owns it (without becoming a platform
 *  admin) → the owner adds an existing user directly → only that workspace
 *  is granted; everyone else stays isolated. Disposable test database.
 */
const { connect } = useSocketHarness();

const as = (u: { token: string }) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body?: object) => request(app).post(path).set(authHeader(u.token)).send(body ?? {}),
  patch: (path: string, body?: object) => request(app).patch(path).set(authHeader(u.token)).send(body ?? {}),
  del: (path: string) => request(app).delete(path).set(authHeader(u.token)),
});
const tag = () => randomUUID().slice(0, 8);
const login = (loginId: string, password: string) => request(app).post('/api/auth/login').send({ email: loginId, password });

/** Provisions an account through the admin API and logs it in. */
const provision = async (admin: TestUser, overrides: Record<string, unknown> = {}) => {
  const t = tag();
  const body = { username: `p2user_${t}`, loginId: `p2_${t}@2003`, password: `pass-${t}`, ...overrides };
  const created = await as(admin).post('/api/admin/users', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const session = await login(body.loginId as string, body.password as string);
  expect(session.status).toBe(200);
  return { ...body, id: created.body.id as string, token: session.body.token as string, created: created.body };
};

const noPasswordAnywhere = (body: unknown) => {
  const json = JSON.stringify(body);
  expect(json).not.toMatch(/"password"/i);
  expect(json).not.toMatch(/\$2[aby]\$\d{2}\$/); // no bcrypt hash
};

describe('platform user provisioning (P2)', () => {
  it('creates an account that can log in immediately with the identifier and password the admin chose', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const t = tag();
    const res = await as(admin).post('/api/admin/users', { username: `sam_${t}`, loginId: `sam${t}@2003`, password: 'sam123', displayName: 'Sam Patel' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: `sam_${t}`, loginId: `sam${t}@2003`, displayName: 'Sam Patel', role: 'USER', status: 'ACTIVE' });
    noPasswordAnywhere(res.body);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: res.body.id }, select: { password: true } });
    expect(stored.password).toMatch(/^\$2[aby]\$12\$/); // hashed with the existing cost, never plain text
    expect(stored.password).not.toContain('sam123');

    const session = await login(`sam${t}@2003`, 'sam123');
    expect(session.status).toBe(200);
    expect(session.body.user).toMatchObject({ username: `sam_${t}`, role: 'USER' });
    expect((await login(`sam${t}@2003`, 'wrong-password')).status).toBe(401);
  });

  it('validates input and enforces unique usernames and logins', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const t = tag();
    const ok = { username: `dup_${t}`, loginId: `dup_${t}@x`, password: 'secret1' };
    expect((await as(admin).post('/api/admin/users', ok)).status).toBe(201);
    expect((await as(admin).post('/api/admin/users', { ...ok, loginId: `other_${t}@x` })).status).toBe(409);
    expect((await as(admin).post('/api/admin/users', { ...ok, username: `other_${t}`, loginId: ok.loginId.toUpperCase() })).status).toBe(409);
    for (const bad of [
      { ...ok, username: 'a' },
      { ...ok, username: 'has space' },
      { ...ok, username: `x${'y'.repeat(45)}` },
      { ...ok, loginId: 'has space@x' },
      { ...ok, loginId: 'ab' },
      { ...ok, loginId: 'system@smartconnect.internal' },
      { ...ok, password: '12345' },
      { ...ok, password: 'x'.repeat(129) },
      { ...ok, status: 'BANNED' },
      { ...ok, displayName: 'x'.repeat(81) },
      { ...ok, displayName: 'bad\u0000name' },
    ]) {
      const res = await as(admin).post('/api/admin/users', { ...bad, username: bad.username === ok.username ? `v_${tag()}` : bad.username, loginId: bad.loginId === ok.loginId ? `v_${tag()}@x` : bad.loginId });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('only platform admins can provision, search, view or reset accounts', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const someone = await provision(admin);
    const plain = await createAndLoginUser();
    for (const [method, path] of [
      ['get', '/api/admin/users'],
      ['post', '/api/admin/users'],
      ['get', `/api/admin/users/${someone.id}`],
      ['patch', `/api/admin/users/${someone.id}/profile`],
      ['post', `/api/admin/users/${someone.id}/password`],
    ] as const) {
      expect((await as(plain)[method](path, { username: `x_${tag()}`, loginId: `x_${tag()}@x`, password: 'secret1' })).status, `${method} ${path}`).toBe(403);
      expect((await request(app)[method](path)).status, `${method} ${path} (no token)`).toBe(401);
    }
  });

  it('lists and searches accounts server-side, never exposing hashes or system accounts', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const t = tag();
    const a = await provision(admin, { username: `findme_${t}`, displayName: `Findable ${t}` });
    const paused = { username: `paused_${t}`, loginId: `paused_${t}@2003`, password: 'secret1', status: 'SUSPENDED' };
    expect((await as(admin).post('/api/admin/users', paused)).status).toBe(201);
    expect((await login(paused.loginId, paused.password)).status).toBe(403); // a SUSPENDED account cannot log in
    for (const q of [`findme_${t}`, a.loginId, `Findable ${t}`]) {
      const res = await as(admin).get(`/api/admin/users?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(res.body.users.map((u: { id: string }) => u.id), q).toContain(a.id);
      noPasswordAnywhere(res.body);
    }
    const suspended = await as(admin).get(`/api/admin/users?q=paused_${t}&status=SUSPENDED`);
    expect(suspended.body.users).toHaveLength(1);
    expect((await as(admin).get('/api/admin/users?q=smartconnect.internal')).body.users).toEqual([]);
    const page1 = await as(admin).get('/api/admin/users?limit=2');
    const page2 = await as(admin).get(`/api/admin/users?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page1.body.users).toHaveLength(2);
    expect(page2.body.users.map((u: { id: string }) => u.id)).not.toContain(page1.body.users[0].id);
  });

  it('shows who created an account and its workspaces; edits the display name; sets a new password', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const user = await provision(admin);
    await grantTier(user.id); // Stage 1: workspace creators are Team Leads (Stage 2: granted by the admin flow)
    const { workspaceId } = await createWorkspace(user as unknown as TestUser);
    const details = await as(admin).get(`/api/admin/users/${user.id}`);
    expect(details.body.createdBy).toBe(admin.user.username);
    expect(details.body.workspaces).toEqual(expect.arrayContaining([expect.objectContaining({ workspaceId, role: 'OWNER', shared: false })]));
    noPasswordAnywhere(details.body);

    expect((await as(admin).patch(`/api/admin/users/${user.id}/profile`, { displayName: 'Renamed Person' })).body.displayName).toBe('Renamed Person');
    expect((await as(admin).post(`/api/admin/users/${user.id}/password`, { password: 'brand-new-1' })).status).toBe(200);
    expect((await login(user.loginId as string, user.password as string)).status).toBe(401);
    expect((await login(user.loginId as string, 'brand-new-1')).status).toBe(200);
    expect((await as(admin).post(`/api/admin/users/${admin.user.id}/password`, { password: 'whatever1' })).status).toBe(400);
    const system = await prisma.user.findUnique({ where: { email: 'system@smartconnect.internal' }, select: { id: true } });
    if (system) expect((await as(admin).post(`/api/admin/users/${system.id}/password`, { password: 'whatever1' })).status).toBe(403);
  });
});

describe('workspace creation and direct membership (P2)', () => {
  it('the creator owns and administers the new workspace without becoming a platform admin', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const owner = await provision(admin);
    await grantTier(owner.id); // Stage 1: workspace creators are Team Leads (Stage 2: granted by the admin flow)
    const res = await as(owner).post('/api/workspaces', { name: `Acme Engineering ${tag()}` });
    expect(res.status).toBe(201);
    const workspaceId = res.body.workspace.id;
    const listed = (await as(owner).get('/api/workspaces')).body.find((w: { id: string }) => w.id === workspaceId);
    expect(listed).toMatchObject({ isOwner: true, myRole: 'ADMIN' });
    expect(listed.capabilities.canManage).toBe(true);
    expect((await as(owner).get('/api/auth/me')).body.role ?? (await as(owner).get('/api/auth/me')).body.user?.role).toBe('USER');
    expect((await as(owner).get('/api/admin/users')).status).toBe(403);
  });

  it('a manager finds a registered user (no e-mails exposed) and adds them directly — only that workspace', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const owner = await provision(admin);
    const member = await provision(admin, { displayName: `Bee ${tag()}` });
    const outsider = await provision(admin);
    await grantTier(owner.id); // Stage 1: workspace creators are Team Leads
    const { workspaceId, generalChannelId } = await createWorkspace(owner as unknown as TestUser);
    const other = await createWorkspace(owner as unknown as TestUser); // a second private workspace of the same owner

    const found = await as(owner).get(`/api/workspaces/${workspaceId}/member-candidates?q=${member.username}`);
    expect(found.status).toBe(200);
    expect(found.body.users).toEqual([{ id: member.id, username: member.username, displayName: (member as { displayName?: string | null }).displayName }]);
    expect((await as(owner).get(`/api/workspaces/${workspaceId}/member-candidates?q=${encodeURIComponent(member.loginId as string)}`)).body.users.map((u: { id: string }) => u.id)).toEqual([member.id]);
    expect((await as(owner).get(`/api/workspaces/${workspaceId}/member-candidates?q=@2003`)).body.users).toEqual([]); // no substring login search
    expect((await as(member).get(`/api/workspaces/${workspaceId}/member-candidates?q=x`)).status).toBe(403);

    // Live: the member's open socket gets the workspace and its General right away.
    const memberConn = await connect(member as unknown as TestUser);
    const refreshed = nextEvent<{ workspaceId: string }>(memberConn.socket, 'workspace:member_updated', (p) => p.workspaceId === workspaceId);
    const added = await as(owner).post(`/api/workspaces/${workspaceId}/members`, { userId: member.id });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ id: member.id, username: member.username, role: 'MEMBER', isOwner: false });
    await refreshed;
    const ownerConn = await connect(owner as unknown as TestUser);
    const arrives = nextEvent<{ content: string }>(memberConn.socket, 'message:received', (m) => m.content.includes('welcome aboard'));
    expect((await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: '<p>welcome aboard</p>' })).ok).toBe(true);
    await arrives;

    expect((await as(member).get('/api/workspaces')).body.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([workspaceId]));
    expect((await as(member).get('/api/workspaces')).body.map((w: { id: string }) => w.id)).not.toContain(other.workspaceId);
    expect((await as(member).get(`/api/channels/${generalChannelId}/messages`)).status).toBe(200);
    expect((await as(owner).post(`/api/workspaces/${workspaceId}/members`, { userId: member.id })).status).toBe(409); // no duplicates
    expect(await prisma.workspaceMember.count({ where: { userId: member.id, workspaceId } })).toBe(1);

    // Not a manager / not a member / inactive / unknown: refused.
    expect((await as(member).post(`/api/workspaces/${workspaceId}/members`, { userId: outsider.id })).status).toBe(403);
    expect((await as(outsider).post(`/api/workspaces/${workspaceId}/members`, { userId: outsider.id })).status).toBe(403);
    await prisma.user.update({ where: { id: outsider.id }, data: { status: 'SUSPENDED' } });
    expect((await as(owner).post(`/api/workspaces/${workspaceId}/members`, { userId: outsider.id })).status).toBe(409);
    expect((await as(owner).post(`/api/workspaces/${workspaceId}/members`, { userId: randomUUID() })).status).toBe(404);
  });

  it('someone who was never added cannot reach the private workspace in any way', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const owner = await provision(admin);
    const stranger = await provision(admin);
    await grantTier(owner.id); // Stage 1: workspace creators are Team Leads
    const { workspaceId, generalChannelId } = await createWorkspace(owner as unknown as TestUser);
    const ownerConn = await connect(owner as unknown as TestUser);
    await emitAck(ownerConn.socket, 'message:send', { channelId: generalChannelId, content: '<p>private plans</p>' });

    expect((await as(stranger).get('/api/workspaces')).body.map((w: { id: string }) => w.id)).not.toContain(workspaceId);
    for (const path of [
      `/api/workspaces/${workspaceId}/channels`,
      `/api/workspaces/${workspaceId}/members`,
      `/api/workspaces/${workspaceId}/settings`,
      `/api/workspaces/${workspaceId}/projects`,
      `/api/workspaces/${workspaceId}/dms`,
      `/api/channels/${generalChannelId}/messages`,
      `/api/channels/${generalChannelId}/search?q=private`,
      `/api/channels/${generalChannelId}/members`,
    ]) {
      const res = await as(stranger).get(path);
      expect([403, 404], `${path} -> ${res.status}`).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain('private plans');
    }
    const strangerConn = await connect(stranger as unknown as TestUser);
    expect(strangerConn.channelIds).not.toContain(generalChannelId);
    const join = await emitAck(strangerConn.socket, 'channel:join', generalChannelId);
    expect(join.ok).toBe(false);
  });
});
