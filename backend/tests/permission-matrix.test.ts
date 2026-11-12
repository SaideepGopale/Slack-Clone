import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser, uniqueEmail } from './helpers';
import { addToWorkspace, createWorkspace, TestUser } from './collab-helpers';
import { collect, emitAck, nextEvent, useSocketHarness } from './socket-harness';

// Never send real email from tests, whatever the local environment holds.
vi.mock('../utils/mailer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/mailer')>()),
  sendInviteEmail: vi.fn().mockResolvedValue({ success: true }),
}));

/**
 * Sub-batch E — cross-module permission matrix. One shared world:
 *
 *   Organization (orgOwner = OWNER, orgAdmin = explicit ADMIN, orgMember =
 *   implicit MEMBER via a second workspace)
 *   └─ ws1 (owner: orgOwner; wsAdmin = ADMIN; everyone else below = MEMBER)
 *      ├─ P1 public project, P2 private project (projOwner OWNER, projMember MEMBER)
 *      ├─ C1 public channel, C2 private channel (chanOwner owner, chanMod
 *      │  moderator, chanMember member), C3 public announcement channel
 *      └─ removed = was a member of ws1, P2 and C2, removed through the API
 *   outsider = unrelated account; banned = ws1 member whose account is BANNED
 *
 * Every expected status is written out literally per actor.
 */

const harness = useSocketHarness();

const api = (user: TestUser) => ({
  get: (url: string) => request(app).get(url).set(authHeader(user.token)),
  post: (url: string, body: object = {}) => request(app).post(url).set(authHeader(user.token)).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set(authHeader(user.token)).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set(authHeader(user.token)).send(body),
  del: (url: string) => request(app).delete(url).set(authHeader(user.token)),
});

const ACTORS = [
  'orgOwner',
  'orgAdmin',
  'orgMember',
  'wsAdmin',
  'wsMember',
  'projOwner',
  'projMember',
  'chanOwner',
  'chanMod',
  'chanMember',
  'outsider',
  'removed',
] as const;
type ActorName = (typeof ACTORS)[number];

interface World {
  users: Record<ActorName | 'pawn' | 'banned', TestUser>;
  orgId: string;
  ws1: string;
  general1: string;
  P1: string;
  P2: string;
  C1: string;
  C2: string;
  C3: string;
}
let w: World;

const ok = <T>(res: request.Response, status: number) => {
  // `req` exists at runtime on supertest responses but is not in its typings.
  const sent = (res as request.Response & { req?: { method?: string; path?: string } }).req;
  expect(res.status, `${sent?.method} ${sent?.path} → ${JSON.stringify(res.body)}`).toBe(status);
  return res.body as T;
};

beforeAll(async () => {
  const names = [...ACTORS, 'pawn', 'banned'] as const;
  const created = await Promise.all(names.map(() => createAndLoginUser()));
  const users = Object.fromEntries(names.map((n, i) => [n, created[i]])) as World['users'];
  const { orgOwner } = users;

  const ws = await createWorkspace(orgOwner, 'Matrix HQ');
  const orgId = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } })).organizationId!;
  const second = ok<{ workspace: { id: string }; generalChannel: { id: string } }>(
    await api(orgOwner).post('/api/workspaces', { name: 'Matrix Branch', organizationId: orgId }),
    201
  );
  await prisma.organizationMember.create({ data: { organizationId: orgId, userId: users.orgAdmin.user.id, role: 'ADMIN' } });
  await addToWorkspace(users.orgMember, second.workspace.id, [second.generalChannel.id]);

  for (const n of ['wsAdmin', 'wsMember', 'projOwner', 'projMember', 'chanOwner', 'chanMod', 'chanMember', 'removed', 'pawn', 'banned'] as const) {
    await addToWorkspace(users[n], ws.workspaceId, [ws.generalChannelId]);
  }
  await prisma.workspaceMember.update({
    where: { userId_workspaceId: { userId: users.wsAdmin.user.id, workspaceId: ws.workspaceId } },
    data: { role: 'ADMIN' },
  });

  const P1 = ok<{ id: string }>(await api(users.projOwner).post(`/api/workspaces/${ws.workspaceId}/projects`, { name: 'Open' }), 201).id;
  const P2 = ok<{ id: string }>(
    await api(users.projOwner).post(`/api/workspaces/${ws.workspaceId}/projects`, { name: 'Covert', visibility: 'PRIVATE' }),
    201
  ).id;
  for (const n of ['projMember', 'removed'] as const) {
    ok(await api(users.projOwner).post(`/api/projects/${P2}/members`, { userId: users[n].user.id }), 201);
  }

  const channel = async (body: object) =>
    ok<{ id: string }>(await api(users.chanOwner).post('/api/channels', { workspaceId: ws.workspaceId, ...body }), 201).id;
  const C1 = await channel({ name: 'matrix-public' });
  const C2 = await channel({ name: 'matrix-private', visibility: 'PRIVATE' });
  const C3 = await channel({ name: 'matrix-news', isAnnouncement: true });
  for (const n of ['chanMod', 'chanMember', 'removed'] as const) {
    ok(await api(users.chanOwner).post(`/api/channels/${C2}/members`, { userId: users[n].user.id }), 201);
  }
  for (const n of ['chanMod', 'chanMember', 'wsAdmin', 'removed'] as const) {
    ok(await api(users.chanOwner).post(`/api/channels/${C3}/members`, { userId: users[n].user.id }), 201);
  }
  for (const id of [C2, C3]) ok(await api(users.chanOwner).patch(`/api/channels/${id}/members/${users.chanMod.user.id}`, { role: 'moderator' }), 200);

  // Revoked membership: removed through the real API (immediate revocation path).
  ok(await api(users.wsAdmin).del(`/api/workspaces/${ws.workspaceId}/members/${users.removed.user.id}`), 200);
  await prisma.user.update({ where: { id: users.banned.user.id }, data: { status: 'BANNED' } });

  w = { users, orgId, ws1: ws.workspaceId, general1: ws.generalChannelId, P1, P2, C1, C2, C3 };
}, 60_000);

// ---- the matrix ---------------------------------------------------------------

type Expect = number | 'skip'; // 'skip' = allowed but destructive; covered by a dedicated test below
type Row = [label: string, run: (actor: TestUser) => Promise<request.Response>, expected: Record<ActorName, Expect>];

const row = (...statuses: Expect[]): Record<ActorName, Expect> =>
  Object.fromEntries(ACTORS.map((a, i) => [a, statuses[i]])) as Record<ActorName, Expect>;

//                                        orgOwner orgAdmin orgMember wsAdmin wsMember projOwner projMember chanOwner chanMod chanMember outsider removed
const MATRIX: () => Row[] = () => [
  ['invite by email', (u) => api(u).post(`/api/workspaces/${w.ws1}/invites`, { email: uniqueEmail() }),
    row(201, 201, 403, 201, 403, 403, 403, 403, 403, 403, 403, 403)],
  ['get invite link', (u) => api(u).get(`/api/workspaces/${w.ws1}/invite-link`),
    row(200, 200, 403, 200, 403, 403, 403, 403, 403, 403, 403, 403)],
  ['list join requests', (u) => api(u).get(`/api/workspaces/${w.ws1}/requests`),
    row(200, 200, 403, 200, 403, 403, 403, 403, 403, 403, 403, 403)],
  ['list invitations', (u) => api(u).get(`/api/workspaces/${w.ws1}/invitations`),
    row(200, 200, 403, 200, 403, 403, 403, 403, 403, 403, 403, 403)],
  ['view workspace settings', (u) => api(u).get(`/api/workspaces/${w.ws1}/settings`),
    row(200, 200, 403, 200, 200, 200, 200, 200, 200, 200, 403, 403)],
  ['member directory', (u) => api(u).get(`/api/workspaces/${w.ws1}/members`),
    row(200, 200, 403, 200, 200, 200, 200, 200, 200, 200, 403, 403)],
  ['update workspace settings', (u) => api(u).patch(`/api/workspaces/${w.ws1}`, { description: 'Matrix' }),
    row(200, 200, 403, 200, 403, 403, 403, 403, 403, 403, 403, 403)],
  ['delete workspace', (u) => api(u).del(`/api/workspaces/${w.ws1}`),
    row('skip', 'skip', 403, 403, 403, 403, 403, 403, 403, 403, 403, 403)],
  ['change a workspace role (no-op)', (u) => api(u).patch(`/api/workspaces/${w.ws1}/members/${w.users.pawn.user.id}`, { role: 'MEMBER' }),
    row(200, 200, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403)],
  ['remove a workspace member', (u) => api(u).del(`/api/workspaces/${w.ws1}/members/${w.users.pawn.user.id}`),
    row('skip', 'skip', 403, 'skip', 403, 403, 403, 403, 403, 403, 403, 403)],
  ['unread state (content gate)', (u) => api(u).get(`/api/workspaces/${w.ws1}/unread`),
    row(200, 403, 403, 200, 200, 200, 200, 200, 200, 200, 403, 403)],
  ['create a channel', (u) => api(u).post('/api/channels', { workspaceId: w.ws1, name: `m-${Math.random().toString(36).slice(2, 10)}` }),
    row(201, 403, 403, 201, 201, 201, 201, 201, 201, 201, 403, 403)],
  ['create a project', (u) => api(u).post(`/api/workspaces/${w.ws1}/projects`, { name: 'Scratch' }),
    row(201, 403, 403, 201, 201, 201, 201, 201, 201, 201, 403, 403)],
  ['view public project', (u) => api(u).get(`/api/projects/${w.P1}`),
    row(200, 200, 404, 200, 200, 200, 200, 200, 200, 200, 404, 404)],
  ['view private project', (u) => api(u).get(`/api/projects/${w.P2}`),
    row(200, 200, 404, 200, 404, 200, 200, 404, 404, 404, 404, 404)],
  ['change a private-project role (no-op)', (u) => api(u).patch(`/api/projects/${w.P2}/members/${w.users.projMember.user.id}`, { role: 'MEMBER' }),
    row(200, 200, 404, 200, 404, 200, 403, 404, 404, 404, 404, 404)],
  ['view public channel', (u) => api(u).get(`/api/channels/${w.C1}/details`),
    row(200, 200, 404, 200, 200, 200, 200, 200, 200, 200, 404, 404)],
  ['view private channel', (u) => api(u).get(`/api/channels/${w.C2}/details`),
    row(200, 200, 404, 200, 404, 404, 404, 200, 200, 200, 404, 404)],
  ['read private channel', (u) => api(u).get(`/api/channels/${w.C2}/messages`),
    row(403, 403, 403, 403, 403, 403, 403, 200, 200, 200, 403, 403)],
  ['change a private-channel role (no-op)', (u) => api(u).patch(`/api/channels/${w.C2}/members/${w.users.chanMember.user.id}`, { role: 'member' }),
    row(200, 200, 404, 200, 404, 404, 404, 200, 403, 403, 404, 404)],
  // 400 = authorized, then refused because the target isn't in the workspace (no state change).
  ['add an outsider to the private channel', (u) => api(u).post(`/api/channels/${w.C2}/members`, { userId: w.users.outsider.user.id }),
    row(400, 400, 404, 400, 404, 404, 404, 400, 400, 403, 404, 404)],
  ['archive the private channel', (u) => api(u).post(`/api/channels/${w.C2}/archive`),
    row('skip', 'skip', 404, 'skip', 404, 404, 404, 'skip', 403, 403, 404, 404)],
];

describe('cross-module permission matrix (REST)', () => {
  it('every actor gets exactly the expected answer for every action', async () => {
    const failures: string[] = [];
    for (const [label, run, expected] of MATRIX()) {
      for (const actor of ACTORS) {
        const want = expected[actor];
        if (want === 'skip') continue;
        const res = await run(w.users[actor]);
        if (res.status !== want) failures.push(`${label} as ${actor}: expected ${want}, got ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
    // The no-op rows really were no-ops.
    expect((await prisma.workspaceMember.findUniqueOrThrow({ where: { userId_workspaceId: { userId: w.users.pawn.user.id, workspaceId: w.ws1 } } })).role).toBe('MEMBER');
    expect(await prisma.channel.count({ where: { id: w.C2, archivedAt: { not: null } } })).toBe(0);
  }, 120_000);

  it('hidden resources never reveal their names', async () => {
    for (const actor of ['wsMember', 'outsider', 'removed', 'orgMember'] as const) {
      const project = await api(w.users[actor]).get(`/api/projects/${w.P2}`);
      const channel = await api(w.users[actor]).get(`/api/channels/${w.C2}/details`);
      expect(JSON.stringify([project.body, channel.body])).not.toMatch(/Covert|matrix-private/);
    }
  });
});

// ---- destructive "allowed" cells, each on throwaway resources ------------------------

describe('workspace deletion and member removal (allowed cells)', () => {
  it('owner and organization admins delete workspaces; a workspace ADMIN cannot', async () => {
    const { orgOwner, orgAdmin, wsAdmin } = w.users;
    const fresh = async () =>
      ok<{ workspace: { id: string } }>(await api(orgOwner).post('/api/workspaces', { name: `Throwaway ${Math.random()}`, organizationId: w.orgId }), 201)
        .workspace.id;
    const a = await fresh();
    await addToWorkspace(wsAdmin, a);
    await prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: wsAdmin.user.id, workspaceId: a } }, data: { role: 'ADMIN' } });
    const denied = await api(wsAdmin).del(`/api/workspaces/${a}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/owner or organization admins/);
    expect(await prisma.workspace.count({ where: { id: a } })).toBe(1);
    expect((await api(wsAdmin).get('/api/workspaces')).body.find((x: { id: string }) => x.id === a).capabilities).toMatchObject({ canDelete: false, canManageInvitations: true });

    ok(await api(orgOwner).del(`/api/workspaces/${a}`), 200);
    const b = await fresh();
    ok(await api(orgAdmin).del(`/api/workspaces/${b}`), 200); // inheritance, without membership
    expect(await prisma.workspace.count({ where: { id: { in: [a, b] } } })).toBe(0);
  });

  it('organization admins remove members (inheritance) with immediate revocation', async () => {
    const { orgOwner, orgAdmin } = w.users;
    const victim = await createAndLoginUser();
    const ws = await createWorkspace(orgOwner);
    await prisma.workspace.update({ where: { id: ws.workspaceId }, data: { organizationId: w.orgId } });
    await addToWorkspace(victim, ws.workspaceId, [ws.generalChannelId]);
    const conn = await harness.connect(victim);
    expect(conn.channelIds).toContain(ws.generalChannelId);

    const removed = nextEvent<{ workspaceId: string; reason: string }>(conn.socket, 'workspace:removed');
    ok(await api(orgAdmin).del(`/api/workspaces/${ws.workspaceId}/members/${victim.user.id}`), 200);
    expect(await removed).toEqual({ workspaceId: ws.workspaceId, reason: 'removed' });
    const leaked = collect(conn.socket, 'message:received', 600);
    const ownerConn = await harness.connect(orgOwner);
    expect((await emitAck(ownerConn.socket, 'message:send', { channelId: ws.generalChannelId, content: 'after removal' })).ok).toBe(true);
    expect(await leaked).toHaveLength(0);
    expect((await emitAck(conn.socket, 'message:send', { channelId: ws.generalChannelId, content: 'still here?' })).ok).toBe(false);
    expect((await api(victim).get(`/api/workspaces/${ws.workspaceId}/unread`)).status).toBe(403);
  });
});

// ---- invitations -------------------------------------------------------------------

describe('email invitations', () => {
  const invite = async (by: TestUser, workspaceId: string, email: string) =>
    ok<{ token: string; id: string }>(await api(by).post(`/api/workspaces/${workspaceId}/invites`, { email }), 201);

  it('binds to the invited address (case-insensitively), grants MEMBER once, and is single-use', async () => {
    const { wsAdmin, outsider } = w.users;
    const invitee = await createAndLoginUser();
    const { token } = await invite(wsAdmin, w.ws1, invitee.user.email.toUpperCase());
    expect((await prisma.invitation.findUniqueOrThrow({ where: { token } })).email).toBe(invitee.user.email.toLowerCase());

    const lookup = await request(app).get(`/api/invitations/${token}`);
    expect(lookup.body).toMatchObject({ valid: true, workspaceId: w.ws1, isExistingUser: true });

    const wrong = await api(outsider).post(`/api/invitations/accept/${token}`);
    expect(wrong.status).toBe(403);
    // A client-supplied role or workspace is ignored: the invitation decides both.
    const accepted = await api(invitee).post(`/api/invitations/accept/${token}`, { role: 'ADMIN', workspaceId: w.users.orgMember.user.id });
    expect(accepted.status).toBe(200);
    expect(accepted.body.workspaceId).toBe(w.ws1);
    const membership = await prisma.workspaceMember.findUniqueOrThrow({ where: { userId_workspaceId: { userId: invitee.user.id, workspaceId: w.ws1 } } });
    expect(membership.role).toBe('MEMBER');
    expect((await api(invitee).post(`/api/invitations/accept/${token}`)).status).toBe(200); // same person again: harmless
    expect((await api(outsider).post(`/api/invitations/accept/${token}`)).status).toBe(400); // used
  });

  it('expired, revoked and orphaned invitations stop working; banned accounts cannot accept', async () => {
    const { wsAdmin, orgOwner, wsMember } = w.users;
    const invitee = await createAndLoginUser();

    const expired = await invite(wsAdmin, w.ws1, invitee.user.email);
    await prisma.invitation.update({ where: { id: expired.id }, data: { createdAt: new Date(Date.now() - 15 * 24 * 3600 * 1000) } });
    expect((await request(app).get(`/api/invitations/${expired.token}`)).body.error).toBe('This invitation has expired.');
    expect((await api(invitee).post(`/api/invitations/accept/${expired.token}`)).status).toBe(400);

    const revoked = await invite(wsAdmin, w.ws1, invitee.user.email);
    expect((await api(wsMember).del(`/api/workspaces/${w.ws1}/invitations/${revoked.id}`)).status).toBe(403);
    ok(await api(orgOwner).del(`/api/workspaces/${w.ws1}/invitations/${revoked.id}`), 200);
    expect((await api(orgOwner).del(`/api/workspaces/${w.ws1}/invitations/${revoked.id}`)).status).toBe(400);
    expect((await api(invitee).post(`/api/invitations/accept/${revoked.token}`)).body.error).toBe('This invitation has been revoked.');

    // The inviter lost the right to invite → their outstanding invitations die with it.
    const temp = await createAndLoginUser();
    await addToWorkspace(temp, w.ws1);
    await prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: temp.user.id, workspaceId: w.ws1 } }, data: { role: 'ADMIN' } });
    const orphan = await invite(temp, w.ws1, invitee.user.email);
    expect((await api(temp).get('/api/invitations')).body.map((i: { id: string }) => i.id)).toContain(orphan.id);
    ok(await api(orgOwner).patch(`/api/workspaces/${w.ws1}/members/${temp.user.id}`, { role: 'MEMBER' }), 200);
    expect((await api(temp).get('/api/invitations')).body.map((i: { id: string }) => i.id)).not.toContain(orphan.id);
    expect((await request(app).get(`/api/invitations/${orphan.token}`)).status).toBe(400);
    expect((await api(invitee).post(`/api/invitations/accept/${orphan.token}`)).body.error).toBe('This invitation is no longer valid.');

    const banned = w.users.banned;
    const forBanned = await invite(wsAdmin, w.ws1, `${Math.random().toString(36).slice(2)}@example.com`);
    await prisma.invitation.update({ where: { id: forBanned.id }, data: { email: banned.user.email.toLowerCase() } });
    // T.32 (audit H1): a banned account's session no longer authenticates at all (401, was 403 from the accept rule).
    expect((await api(banned).post(`/api/invitations/accept/${forBanned.token}`)).status).toBe(401);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: w.ws1, userId: invitee.user.id } })).toBe(0);
  });

  it('a letter-case twin account cannot exist, so one invitation has one possible account; concurrent accepts by it are idempotent', async () => {
    // Stage 6C (T.27): sign-up once allowed "Ann@x" and "ann@x" as two accounts (audit DB-04),
    // and this test raced such twins for one invitation. The case-insensitive unique index
    // ("User_email_lower_key", migration 20261111100000) now refuses the twin itself.
    const first = await createAndLoginUser();
    const twin = await createAndLoginUser();
    await expect(prisma.user.update({ where: { id: twin.user.id }, data: { email: first.user.email.toUpperCase() } })).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['lower(email)'] },
    });
    const { token } = await invite(w.users.wsAdmin, w.ws1, first.user.email);
    const results = await Promise.all([
      api(first).post(`/api/invitations/accept/${token}`),
      api(first).post(`/api/invitations/accept/${token}`),
    ]);
    // The atomic single-use flip still decides; a duplicate accept by the same person is a harmless success.
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: w.ws1, userId: first.user.id } })).toBe(1);
    expect((await api(twin).post(`/api/invitations/accept/${token}`)).status).not.toBe(200);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: w.ws1, userId: twin.user.id } })).toBe(0);
  });

  it('managers list invitations without tokens; invitations never cross workspaces', async () => {
    const { wsAdmin, orgOwner } = w.users;
    const created = await invite(wsAdmin, w.ws1, uniqueEmail());
    const list = await api(orgOwner).get(`/api/workspaces/${w.ws1}/invitations`);
    expect(list.body.find((i: { id: string }) => i.id === created.id)).toMatchObject({ state: 'pending', inviter: { id: wsAdmin.user.id } });
    expect(JSON.stringify(list.body)).not.toContain(created.token);

    const other = await createWorkspace(orgOwner);
    expect((await api(orgOwner).del(`/api/workspaces/${other.workspaceId}/invitations/${created.id}`)).status).toBe(404);
    expect((await api(wsAdmin).post(`/api/workspaces/${other.workspaceId}/invites`, { email: uniqueEmail() })).status).toBe(403);
    expect((await api(wsAdmin).post('/api/workspaces/00000000-0000-4000-8000-000000000000/invites', { email: uniqueEmail() })).status).toBe(404);
  });
});

// ---- invite links and join requests -------------------------------------------------

describe('invite links and join requests', () => {
  const linkToken = async (by: TestUser, workspaceId: string) =>
    new URL(ok<{ url: string }>(await api(by).get(`/api/workspaces/${workspaceId}/invite-link`), 200).url).searchParams.get('token')!;
  const requestOf = async (workspaceId: string, user: TestUser) =>
    prisma.workspaceJoinRequest.findUniqueOrThrow({ where: { userId_workspaceId: { userId: user.user.id, workspaceId } } });

  it('organization admins run the whole flow; approval grants MEMBER only; links can be revoked', async () => {
    const { orgAdmin, wsMember } = w.users;
    const token = await linkToken(orgAdmin, w.ws1); // not a workspace member
    const joiner = await createAndLoginUser();
    expect((await api(joiner).post('/api/workspaces/join', { token })).body).toEqual({ status: 'pending' });
    const pending = await requestOf(w.ws1, joiner);
    expect((await api(wsMember).put(`/api/workspaces/${w.ws1}/requests/${pending.id}`, { action: 'APPROVE' })).status).toBe(403);
    ok(await api(orgAdmin).put(`/api/workspaces/${w.ws1}/requests/${pending.id}`, { action: 'APPROVE', role: 'ADMIN' }), 200);
    expect((await prisma.workspaceMember.findUniqueOrThrow({ where: { userId_workspaceId: { userId: joiner.user.id, workspaceId: w.ws1 } } })).role).toBe('MEMBER');

    ok(await api(orgAdmin).del(`/api/workspaces/${w.ws1}/invite-link`), 200);
    const late = await createAndLoginUser();
    expect((await api(late).post('/api/workspaces/join', { token })).status).toBe(400);
    expect((await api(wsMember).del(`/api/workspaces/${w.ws1}/invite-link`)).status).toBe(403);
  });

  it('banned accounts cannot request or be approved; a request belongs to one workspace; concurrent decisions resolve once', async () => {
    const { wsAdmin, orgOwner, banned } = w.users;
    const token = await linkToken(wsAdmin, w.ws1);
    // T.32 (audit H1): refused at authentication now (401), before the join rule (was 403).
    expect((await api(banned).post('/api/workspaces/join', { token })).status).toBe(401);

    const later = await createAndLoginUser();
    ok(await api(later).post('/api/workspaces/join', { token }), 200);
    const req = await requestOf(w.ws1, later);
    await prisma.user.update({ where: { id: later.user.id }, data: { status: 'SUSPENDED' } });
    expect((await api(wsAdmin).put(`/api/workspaces/${w.ws1}/requests/${req.id}`, { action: 'APPROVE' })).status).toBe(409);
    await prisma.user.update({ where: { id: later.user.id }, data: { status: 'ACTIVE' } });

    // Addressing the request through another workspace the caller manages → not found.
    const other = await createWorkspace(orgOwner);
    expect((await api(orgOwner).put(`/api/workspaces/${other.workspaceId}/requests/${req.id}`, { action: 'APPROVE' })).status).toBe(404);

    const results = await Promise.all([
      api(wsAdmin).put(`/api/workspaces/${w.ws1}/requests/${req.id}`, { action: 'APPROVE' }),
      api(orgOwner).put(`/api/workspaces/${w.ws1}/requests/${req.id}`, { action: 'REJECT' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const final = await requestOf(w.ws1, later);
    const member = await prisma.workspaceMember.count({ where: { workspaceId: w.ws1, userId: later.user.id } });
    expect(final.status === 'APPROVED' ? 1 : 0).toBe(member);
  });
});

// ---- sockets ---------------------------------------------------------------------------

describe('socket matrix', () => {
  it('announcement posting, removed members and banned accounts over real sockets', async () => {
    const { chanOwner, chanMod, chanMember, wsAdmin, wsMember, removed, banned } = w.users;
    const conns = Object.fromEntries(
      await Promise.all(
        (['chanOwner', 'chanMod', 'chanMember', 'wsAdmin', 'wsMember', 'removed'] as const).map(async (n) => [n, await harness.connect(w.users[n])])
      )
    );
    const send = (n: string, channelId: string) => emitAck(conns[n].socket, 'message:send', { channelId, content: `${n} says hi` });
    const expected: Record<string, boolean> = { chanOwner: true, chanMod: true, wsAdmin: true, chanMember: false, wsMember: false, removed: false };
    for (const [n, allowed] of Object.entries(expected)) {
      expect((await send(n, w.C3)).ok, `${n} top-level in announcement`).toBe(allowed);
    }
    // Private channel C2: only its members; the removed member's rooms are gone.
    expect(conns.removed.channelIds).not.toContain(w.C2);
    expect(conns.removed.channelIds).not.toContain(w.general1);
    expect((await send('removed', w.C2)).ok).toBe(false);
    expect((await send('wsAdmin', w.C2)).ok).toBe(false); // managers manage, never read/post
    expect((await send('chanMember', w.C2)).ok).toBe(true);
    void chanOwner;
    void chanMod;
    void chanMember;
    void wsAdmin;
    void wsMember;
    void removed;

    // Banned accounts can't open a socket at all (frozen handshake, verified only).
    // T.32: the handshake now names the actual status ("banned"), not always "suspended".
    await expect(harness.connect(banned)).rejects.toThrow(/banned/i);
  });
});
