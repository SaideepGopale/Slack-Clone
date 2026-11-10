import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace, TestUser } from './collab-helpers';
import { collect, emitAck, nextEvent, useSocketHarness } from './socket-harness';

/**
 * Sub-batch C — project management: CRUD/lifecycle, visibility, membership
 * and ownership, channel association, cross-workspace isolation,
 * unauthorized access and real-time audiences.
 */

const harness = useSocketHarness();

const api = (user: TestUser) => ({
  get: (url: string) => request(app).get(url).set(authHeader(user.token)),
  post: (url: string, body: object = {}) => request(app).post(url).set(authHeader(user.token)).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set(authHeader(user.token)).send(body),
  del: (url: string) => request(app).delete(url).set(authHeader(user.token)),
});

/** Workspace owned by `owner` with alice, bob and carol as members; `outsider` belongs elsewhere. */
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

type Project = { id: string; name: string; visibility: string; myRole: string | null; archived: boolean };

const newProject = async (user: TestUser, workspaceId: string, body: object = {}): Promise<Project> => {
  const res = await api(user).post(`/api/workspaces/${workspaceId}/projects`, { name: `Project ${Math.random()}`, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

const newChannel = async (user: TestUser, workspaceId: string, extra: object = {}) => {
  const res = await api(user).post('/api/channels', { workspaceId, name: `ch-${Math.random().toString(36).slice(2, 8)}`, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string; projectId: string | null };
};

const addMember = async (actor: TestUser, projectId: string, user: TestUser) => {
  const res = await api(actor).post(`/api/projects/${projectId}/members`, { userId: user.user.id });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

const owners = async (projectId: string) =>
  (await prisma.projectMember.findMany({ where: { projectId, role: 'OWNER' }, select: { userId: true } })).map((m) => m.userId);

describe('project CRUD and lifecycle', () => {
  it('creates a project with the creator as its single OWNER and validates input', async () => {
    const { alice, outsider, workspaceId } = await setup();

    const created = await api(alice).post(`/api/workspaces/${workspaceId}/projects`, { name: '  Apollo  ', description: 'Moon' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Apollo',
      description: 'Moon',
      visibility: 'PUBLIC',
      archived: false,
      memberCount: 1,
      channelCount: 0,
      myRole: 'OWNER',
      owner: { id: alice.user.id },
      capabilities: { canUpdate: true, canArchive: true, canManageMembers: true, canJoin: false, canLeave: false },
    });
    expect(await owners(created.body.id)).toEqual([alice.user.id]);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE_PROJECT', targetId: created.body.id } })).toBe(1);

    const url = `/api/workspaces/${workspaceId}/projects`;
    expect((await api(alice).post(url, { name: '   ' })).status).toBe(400);
    expect((await api(alice).post(url, { name: 'x'.repeat(81) })).status).toBe(400);
    expect((await api(alice).post(url, { name: 'ok', description: 'd'.repeat(501) })).status).toBe(400);
    expect((await api(alice).post(url, { name: 'ok', visibility: 'SECRET' })).status).toBe(400);
    expect((await api(outsider).post(url, { name: 'intrude' })).status).toBe(403);
    expect((await api(alice).post('/api/workspaces/not-a-uuid/projects', { name: 'x' })).status).toBe(404);

    const detail = await api(alice).get(`/api/projects/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.createdBy).toEqual({ id: alice.user.id, username: alice.user.username });
  });

  it('lists, searches and paginates the projects of a workspace', async () => {
    const { alice, workspaceId } = await setup();
    for (const name of ['Gamma', 'Alpha', 'Beta']) await newProject(alice, workspaceId, { name });
    const url = `/api/workspaces/${workspaceId}/projects`;

    const all = await api(alice).get(url);
    expect(all.status).toBe(200);
    expect(all.body.projects.map((p: Project) => p.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(all.body.projects[0]).toMatchObject({ myRole: 'OWNER', memberCount: 1 });

    expect((await api(alice).get(`${url}?q=ET`)).body.projects.map((p: Project) => p.name)).toEqual(['Beta']);

    const first = await api(alice).get(`${url}?limit=2`);
    expect(first.body.projects).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await api(alice).get(`${url}?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.projects.map((p: Project) => p.name)).toEqual(['Gamma']);
    expect(second.body.nextCursor).toBeNull();

    expect((await api(alice).get(`${url}?cursor=00000000-0000-4000-8000-000000000000`)).status).toBe(400);
    expect((await api(alice).get(`${url}?status=bogus`)).status).toBe(400);
  });

  it('edits name and description — project owner or workspace managers only', async () => {
    const { owner, alice, bob, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId);
    const url = `/api/projects/${project.id}`;

    expect((await api(bob).patch(url, { name: 'Hijack' })).status).toBe(403);
    const renamed = await api(alice).patch(url, { name: 'Renamed', description: 'New scope' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed', description: 'New scope' });
    // The workspace owner manages projects without being a member.
    const byManager = await api(owner).patch(url, { description: '' });
    expect(byManager.status).toBe(200);
    expect(byManager.body).toMatchObject({ description: null, myRole: null });
    expect((await api(alice).patch(url, {})).status).toBe(400);
    expect((await api(alice).patch(url, { name: '' })).status).toBe(400);
  });

  it('archive and restore: archived projects are read-only and leave the default list', async () => {
    const { owner, alice, bob, carol, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId);
    const url = `/api/projects/${project.id}`;
    const list = `/api/workspaces/${workspaceId}/projects`;

    expect((await api(bob).post(`${url}/archive`)).status).toBe(403);
    const archived = await api(alice).post(`${url}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: true, archivedBy: { id: alice.user.id } });
    expect((await api(alice).post(`${url}/archive`)).status).toBe(200); // idempotent
    expect(await prisma.auditLog.count({ where: { action: 'ARCHIVE_PROJECT', targetId: project.id } })).toBe(1);

    expect((await api(bob).get(list)).body.projects.some((p: Project) => p.id === project.id)).toBe(false);
    expect((await api(bob).get(`${list}?status=archived`)).body.projects.map((p: Project) => p.id)).toEqual([project.id]);
    expect((await api(bob).get(url)).status).toBe(200); // still viewable

    expect((await api(alice).patch(url, { name: 'Nope' })).status).toBe(409);
    expect((await api(alice).post(`${url}/members`, { userId: carol.user.id })).status).toBe(409);
    expect((await api(bob).post(`${url}/join`)).status).toBe(409);
    const channel = await api(alice).post('/api/channels', { workspaceId, name: 'late', projectId: project.id });
    expect(channel.status).toBe(409);

    const restored = await api(owner).post(`${url}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ archived: false, archivedAt: null, archivedBy: null });
    expect((await api(alice).patch(url, { name: 'Back' })).status).toBe(200);
  });
});

describe('project visibility', () => {
  it('private projects are invisible to workspace members who are not in them', async () => {
    const { owner, alice, bob, outsider, workspaceId } = await setup();
    const secret = await newProject(alice, workspaceId, { name: 'Codename Falcon', visibility: 'PRIVATE' });
    const url = `/api/projects/${secret.id}`;

    const bobList = await api(bob).get(`/api/workspaces/${workspaceId}/projects?status=all&q=Falcon`);
    expect(bobList.status).toBe(200);
    expect(bobList.body.projects).toEqual([]);

    // Every project endpoint answers exactly like a missing project.
    const probes = [
      api(bob).get(url),
      api(bob).get(`${url}/members`),
      api(bob).get(`${url}/channels`),
      api(bob).post(`${url}/join`),
      api(bob).patch(url, { name: 'x' }),
      api(bob).post(`${url}/archive`),
      api(bob).post(`${url}/members`, { userId: bob.user.id }),
      api(outsider).get(url),
      api(alice).get('/api/projects/00000000-0000-4000-8000-000000000000'),
    ];
    for (const res of await Promise.all(probes)) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Project not found.' });
      expect(JSON.stringify(res.body)).not.toContain('Falcon');
    }
    // A cursor pointing at the private project is rejected, not used as an anchor.
    expect((await api(bob).get(`/api/workspaces/${workspaceId}/projects?cursor=${secret.id}`)).status).toBe(400);
    // Its channels don't even show up in the workspace's channel count.
    await newChannel(alice, workspaceId, { projectId: secret.id });
    const channelCount = async (user: TestUser) =>
      (await api(user).get('/api/workspaces')).body.find((w: { id: string }) => w.id === workspaceId)._count.channels;
    expect(await channelCount(alice)).toBe(2); // General + the project channel
    expect(await channelCount(bob)).toBe(1);

    // Managers see it (management metadata), without becoming members.
    const managerView = await api(owner).get(url);
    expect(managerView.status).toBe(200);
    expect(managerView.body).toMatchObject({ myRole: null, capabilities: { canUpdate: true, canJoin: false } });
    expect((await api(owner).get(`/api/workspaces/${workspaceId}/projects`)).body.projects.map((p: Project) => p.id)).toContain(secret.id);
    expect((await api(outsider).get(`/api/workspaces/${workspaceId}/projects`)).status).toBe(403);
  });

  it('public projects are discoverable and joinable by workspace members only', async () => {
    const { alice, bob, outsider, workspaceId } = await setup();
    const open = await newProject(alice, workspaceId, { name: 'Open Roadmap' });
    const url = `/api/projects/${open.id}`;

    const view = await api(bob).get(url);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ myRole: null, capabilities: { canJoin: true, canUpdate: false } });
    const joined = await api(bob).post(`${url}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ myRole: 'MEMBER', memberCount: 2, capabilities: { canJoin: false, canLeave: true } });
    expect((await api(bob).post(`${url}/join`)).status).toBe(200); // idempotent
    expect(await prisma.projectMember.count({ where: { projectId: open.id } })).toBe(2);

    expect((await api(outsider).get(url)).status).toBe(404);
    expect((await api(outsider).post(`${url}/join`)).status).toBe(404);
  });

  it('a project only becomes private when everyone in its channels is a project member', async () => {
    const { alice, bob, carol, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId);
    const channel = await newChannel(alice, workspaceId, { projectId: project.id });
    expect(channel.projectId).toBe(project.id);
    expect((await api(bob).post(`/api/channels/${channel.id}/join`)).status).toBe(200);

    const refused = await api(alice).patch(`/api/projects/${project.id}`, { visibility: 'PRIVATE' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/1 person is in this project's channels/);
    expect((await api(alice).get(`/api/projects/${project.id}`)).body.visibility).toBe('PUBLIC');

    await addMember(alice, project.id, bob);
    expect((await api(alice).patch(`/api/projects/${project.id}`, { visibility: 'PRIVATE' })).status).toBe(200);

    // Now private: carol can neither see nor join its channel; bob keeps access.
    expect((await api(carol).post(`/api/channels/${channel.id}/join`)).status).toBe(404);
    const carolBrowse = await api(carol).get(`/api/channels/all?workspaceId=${workspaceId}`);
    expect(carolBrowse.body.some((c: { id: string }) => c.id === channel.id)).toBe(false);
    const bobBrowse = await api(bob).get(`/api/channels/all?workspaceId=${workspaceId}`);
    expect(bobBrowse.body.some((c: { id: string }) => c.id === channel.id)).toBe(true);
    expect((await api(bob).get(`/api/channels/${channel.id}/messages`)).status).toBe(200);
  });
});

describe('project membership and ownership', () => {
  it('owner and managers add and remove members; members cannot; inputs are validated', async () => {
    const { owner, alice, bob, carol, outsider, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId, { visibility: 'PRIVATE' });
    const members = `/api/projects/${project.id}/members`;

    const added = await api(alice).post(members, { userId: bob.user.id });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ userId: bob.user.id, role: 'MEMBER', user: { username: bob.user.username } });
    expect(added.body.user.email).toBeUndefined();
    expect((await api(alice).post(members, { userId: bob.user.id })).status).toBe(409);
    for (const userId of [outsider.user.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await api(alice).post(members, { userId });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('That user is not a member of this workspace.');
    }
    expect((await api(alice).post(members, { userId: 'nope' })).status).toBe(400);

    expect((await api(bob).post(members, { userId: carol.user.id })).status).toBe(403);
    expect((await api(owner).post(members, { userId: carol.user.id })).status).toBe(201);

    const listed = await api(bob).get(members);
    expect(listed.body.members.map((m: { userId: string; role: string }) => [m.userId, m.role])).toEqual([
      [alice.user.id, 'OWNER'],
      ...[bob, carol]
        .sort((a, b) => a.user.username.localeCompare(b.user.username))
        .map((u) => [u.user.id, 'MEMBER']),
    ]);

    expect((await api(bob).del(`${members}/${carol.user.id}`)).status).toBe(403);
    expect((await api(alice).del(`${members}/${alice.user.id}`)).status).toBe(400);
    expect((await api(owner).del(`${members}/${alice.user.id}`)).status).toBe(400); // owner: transfer first
    expect((await api(alice).del(`${members}/${outsider.user.id}`)).status).toBe(404);
    const removed = await api(alice).del(`${members}/${carol.user.id}`);
    expect(removed.status).toBe(200);
    expect(await prisma.projectMember.count({ where: { projectId: project.id, userId: carol.user.id } })).toBe(0);
    expect((await api(carol).get(`/api/projects/${project.id}`)).status).toBe(404);
  });

  it('ownership transfer keeps exactly one owner; invalid role changes are refused', async () => {
    const { owner, alice, bob, carol, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId);
    await addMember(alice, project.id, bob);
    const member = (u: TestUser) => `/api/projects/${project.id}/members/${u.user.id}`;

    expect((await api(bob).patch(member(bob), { role: 'OWNER' })).status).toBe(403);
    expect((await api(alice).patch(member(bob), { role: 'ADMIN' })).status).toBe(400);
    const demote = await api(alice).patch(member(alice), { role: 'MEMBER' });
    expect(demote.status).toBe(400);
    expect(demote.body.error).toMatch(/exactly one owner/);
    expect((await api(alice).patch(member(carol), { role: 'OWNER' })).status).toBe(404);

    const transferred = await api(alice).patch(member(bob), { role: 'OWNER' });
    expect(transferred.status).toBe(200);
    expect(transferred.body).toMatchObject({ userId: bob.user.id, role: 'OWNER' });
    expect(await owners(project.id)).toEqual([bob.user.id]);
    expect((await api(alice).patch(`/api/projects/${project.id}`, { name: 'x' })).status).toBe(403);

    // A workspace manager can reassign ownership; concurrent transfers still leave one owner.
    await addMember(bob, project.id, carol);
    const results = await Promise.all([
      api(owner).patch(member(alice), { role: 'OWNER' }),
      api(owner).patch(member(carol), { role: 'OWNER' }),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(await owners(project.id)).toHaveLength(1);

    const [currentOwner] = await owners(project.id);
    const ownerUser = [alice, carol].find((u) => u.user.id === currentOwner)!;
    expect((await api(ownerUser).post(`/api/projects/${project.id}/leave`)).status).toBe(400);
    expect((await api(bob).post(`/api/projects/${project.id}/leave`)).status).toBe(200);
    expect((await api(bob).post(`/api/projects/${project.id}/leave`)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: 'TRANSFER_PROJECT_OWNERSHIP', targetId: project.id } })).toBeGreaterThanOrEqual(2);
  });

  it('leaving or being removed from the workspace ends project membership', async () => {
    const { owner, alice, bob, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId, { visibility: 'PRIVATE' });
    await addMember(alice, project.id, bob);
    const channel = await newChannel(alice, workspaceId, { projectId: project.id });
    expect((await api(alice).post(`/api/channels/${channel.id}/members`, { userId: bob.user.id })).status).toBe(201);

    expect((await api(owner).del(`/api/workspaces/${workspaceId}/members/${bob.user.id}`)).status).toBe(200);
    expect(await prisma.projectMember.count({ where: { userId: bob.user.id, projectId: project.id } })).toBe(0);
    expect((await api(bob).get(`/api/projects/${project.id}`)).status).toBe(404);

    // The departing OWNER leaves the project ownerless; managers can still run it.
    expect((await api(alice).post(`/api/workspaces/${workspaceId}/leave`)).status).toBe(200);
    expect(await owners(project.id)).toEqual([]);
    const managerView = await api(owner).get(`/api/projects/${project.id}`);
    expect(managerView.body).toMatchObject({ owner: null, memberCount: 0, capabilities: { canTransferOwnership: true } });
  });
});

describe('channel association', () => {
  it('moves channels in and out of projects without touching ids or memberships', async () => {
    const { alice, bob, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId);
    const channel = await newChannel(alice, workspaceId);
    expect(channel.projectId).toBeNull(); // workspace level by default
    expect((await api(alice).post(`/api/channels/${channel.id}/members`, { userId: bob.user.id })).status).toBe(201);
    const membersBefore = await prisma.channelMember.findMany({ where: { channelId: channel.id }, orderBy: { id: 'asc' } });

    const attached = await api(alice).post(`/api/projects/${project.id}/channels`, { channelId: channel.id });
    expect(attached.status).toBe(200);
    expect(attached.body).toMatchObject({ projectId: project.id, channel: { id: channel.id }, moved: true });
    expect((await prisma.channel.findUnique({ where: { id: channel.id } }))!.projectId).toBe(project.id);
    expect(await prisma.channelMember.findMany({ where: { channelId: channel.id }, orderBy: { id: 'asc' } })).toEqual(membersBefore);
    expect((await api(alice).post(`/api/projects/${project.id}/channels`, { channelId: channel.id })).body.moved).toBe(false);

    const listed = await api(bob).get(`/api/projects/${project.id}/channels`);
    expect(listed.body).toEqual([expect.objectContaining({ id: channel.id, memberCount: 2, isMember: true })]);
    expect((await api(bob).get(`/api/projects/${project.id}`)).body.channelCount).toBe(1);

    const detached = await api(alice).del(`/api/projects/${project.id}/channels/${channel.id}`);
    expect(detached.status).toBe(200);
    expect((await prisma.channel.findUnique({ where: { id: channel.id } }))!.projectId).toBeNull();
    expect(await prisma.channelMember.findMany({ where: { channelId: channel.id }, orderBy: { id: 'asc' } })).toEqual(membersBefore);
    expect((await api(alice).del(`/api/projects/${project.id}/channels/${channel.id}`)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { targetId: channel.id, action: { in: ['MOVE_CHANNEL_TO_PROJECT', 'MOVE_CHANNEL_TO_WORKSPACE'] } } })).toBe(2);
  });

  it('General, DMs and group DMs never join a project; other placement rules are enforced', async () => {
    const { owner, alice, bob, carol, workspaceId, generalChannelId } = await setup();
    const project = await newProject(alice, workspaceId);
    const attach = (user: TestUser, channelId: string, projectId = project.id) =>
      api(user).post(`/api/projects/${projectId}/channels`, { channelId });

    // Workspace managers have full placement power; the guards still hold.
    const general = await attach(owner, generalChannelId);
    expect(general.status).toBe(400);
    expect(general.body.error).toMatch(/General channel always stays at workspace level/);
    const dm = await createDM(alice, bob, workspaceId);
    expect((await attach(owner, dm.id)).status).toBe(400);
    const group = await api(alice).post(`/api/workspaces/${workspaceId}/group-dms`, { userIds: [bob.user.id, carol.user.id] });
    expect(group.status).toBe(201);
    expect((await attach(owner, group.body.id)).status).toBe(400);
    expect((await attach(owner, 'not-a-uuid')).status).toBe(404);

    // Project side: members without management power cannot move channels.
    const bobChannel = await newChannel(bob, workspaceId);
    await addMember(alice, project.id, bob);
    expect((await attach(bob, bobChannel.id)).status).toBe(403);
    // Channel side: the project owner cannot take a channel they don't own…
    const denied = await attach(alice, bobChannel.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/channel owner or workspace admins/);
    // …but a workspace manager can.
    expect((await attach(owner, bobChannel.id)).status).toBe(200);

    // One project at a time.
    const other = await newProject(alice, workspaceId);
    expect((await attach(owner, bobChannel.id, other.id)).status).toBe(409);

    // A private project only accepts a channel whose members are all project members.
    const privateProject = await newProject(alice, workspaceId, { visibility: 'PRIVATE' });
    const shared = await newChannel(alice, workspaceId);
    expect((await api(alice).post(`/api/channels/${shared.id}/members`, { userId: carol.user.id })).status).toBe(201);
    const blocked = await attach(alice, shared.id, privateProject.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/1 member of this channel is not in this private project/);
    await addMember(alice, privateProject.id, carol);
    expect((await attach(alice, shared.id, privateProject.id)).status).toBe(200);

    // Archived projects accept nothing.
    const spare = await newChannel(alice, workspaceId);
    expect((await api(alice).post(`/api/projects/${other.id}/archive`)).status).toBe(200);
    expect((await attach(alice, spare.id, other.id)).status).toBe(409);
  });

  it('creating a channel inside a project requires project membership in the same workspace', async () => {
    const { owner, alice, bob, carol, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId);
    const privateProject = await newProject(alice, workspaceId, { visibility: 'PRIVATE' });

    expect((await newChannel(alice, workspaceId, { projectId: project.id })).projectId).toBe(project.id);
    const notMember = await api(bob).post('/api/channels', { workspaceId, name: 'b', projectId: project.id });
    expect(notMember.status).toBe(403);
    expect(notMember.body.error).toMatch(/Only project members/);
    expect((await api(carol).post('/api/channels', { workspaceId, name: 'c', projectId: privateProject.id })).status).toBe(404);
    // Managers manage but don't get content-level powers such as creating channels inside.
    expect((await api(owner).post('/api/channels', { workspaceId, name: 'o', projectId: privateProject.id })).status).toBe(403);
    expect((await api(alice).post('/api/channels', { workspaceId, name: 'g', projectId: 'garbage' })).status).toBe(404);

    // A private-project channel only admits project members.
    const inside = await newChannel(alice, workspaceId, { projectId: privateProject.id });
    const refused = await api(alice).post(`/api/channels/${inside.id}/members`, { userId: bob.user.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/must be a member of this private project/);
    const addable = await api(alice).get(`/api/channels/${inside.id}/addable-members`);
    expect(addable.body.map((u: { id: string }) => u.id)).not.toContain(bob.user.id);
    await addMember(alice, privateProject.id, bob);
    expect((await api(alice).get(`/api/channels/${inside.id}/addable-members`)).body.map((u: { id: string }) => u.id)).toContain(bob.user.id);
    expect((await api(alice).post(`/api/channels/${inside.id}/members`, { userId: bob.user.id })).status).toBe(201);
  });
});

describe('cross-workspace isolation and unauthorized access', () => {
  it('projects and channels never cross workspace boundaries', async () => {
    const { owner, alice, workspaceId } = await setup();
    const otherWorkspace = await createWorkspace(owner); // owner manages both
    const project = await newProject(alice, workspaceId);
    const foreignChannel = await newChannel(owner, otherWorkspace.workspaceId);
    const foreignProject = await newProject(owner, otherWorkspace.workspaceId);

    const crossAttach = await api(owner).post(`/api/projects/${project.id}/channels`, { channelId: foreignChannel.id });
    expect(crossAttach.status).toBe(404);
    expect(crossAttach.body.error).toBe('Channel not found.');
    const crossCreate = await api(owner).post('/api/channels', { workspaceId, name: 'x', projectId: foreignProject.id });
    expect(crossCreate.status).toBe(404);

    // alice belongs only to the first workspace.
    expect((await api(alice).get(`/api/workspaces/${otherWorkspace.workspaceId}/projects`)).status).toBe(403);
    expect((await api(alice).get(`/api/projects/${foreignProject.id}`)).status).toBe(404);
    expect((await api(alice).post(`/api/projects/${foreignProject.id}/join`)).status).toBe(404);
    expect((await api(alice).post(`/api/workspaces/${otherWorkspace.workspaceId}/projects`, { name: 'x' })).status).toBe(403);
  });

  it('organization managers manage projects without content access', async () => {
    const { alice, workspaceId } = await setup();
    const orgAdmin = await createAndLoginUser();
    const { organizationId } = (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { organizationId: true } }))!;
    await prisma.organizationMember.create({ data: { organizationId: organizationId!, userId: orgAdmin.user.id, role: 'ADMIN' } });
    const project = await newProject(alice, workspaceId, { visibility: 'PRIVATE', name: 'Board' });
    const channel = await newChannel(alice, workspaceId, { projectId: project.id });

    expect((await api(orgAdmin).get(`/api/workspaces/${workspaceId}/projects`)).body.projects.map((p: Project) => p.id)).toContain(project.id);
    expect((await api(orgAdmin).patch(`/api/projects/${project.id}`, { description: 'Reviewed' })).status).toBe(200);
    expect((await api(orgAdmin).get(`/api/projects/${project.id}/channels`)).status).toBe(200);
    // No content: not a workspace member, not a channel member, cannot join or create inside.
    expect((await api(orgAdmin).get(`/api/channels/${channel.id}/messages`)).status).toBe(403);
    expect((await api(orgAdmin).post(`/api/projects/${project.id}/join`)).status).toBe(403);
    expect((await api(orgAdmin).post(`/api/workspaces/${workspaceId}/projects`, { name: 'x' })).status).toBe(403);
  });

  it('stale rows grant nothing: project privacy is re-checked on every channel read', async () => {
    const { alice, carol, outsider, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId, { visibility: 'PRIVATE' });
    const channel = await newChannel(alice, workspaceId, { projectId: project.id });
    // Simulate rows that bypassed the service layer (e.g. a future admin tool).
    await prisma.channelMember.create({ data: { userId: carol.user.id, channelId: channel.id, role: 'member' } });
    await prisma.projectMember.create({ data: { projectId: project.id, userId: outsider.user.id, role: 'MEMBER' } });

    expect((await api(carol).get(`/api/channels/${channel.id}/messages`)).status).toBe(403);
    expect((await api(carol).post(`/api/channels/${channel.id}/read`)).status).toBe(403);
    const carolChannels = await api(carol).get(`/api/workspaces/${workspaceId}/channels`);
    expect(carolChannels.body.some((c: { id: string }) => c.id === channel.id)).toBe(false);
    const unread = await api(carol).get(`/api/workspaces/${workspaceId}/unread`);
    expect(JSON.stringify(unread.body)).not.toContain(channel.id);
    const profile = await api(carol).get(`/api/workspaces/${workspaceId}/members/${alice.user.id}`);
    expect(profile.status).toBe(200);
    expect(profile.body.sharedChannels.map((c: { id: string }) => c.id)).not.toContain(channel.id);
    expect((await api(outsider).get(`/api/projects/${project.id}`)).status).toBe(404);

    const carolConn = await harness.connect(carol);
    expect(carolConn.channelIds).not.toContain(channel.id);
    const post = await emitAck(carolConn.socket, 'message:send', { channelId: channel.id, content: 'sneak' });
    expect(post.ok).toBe(false);
  });

  it('unauthenticated requests are rejected', async () => {
    const { alice, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId);
    expect((await request(app).get(`/api/projects/${project.id}`)).status).toBe(401);
    expect((await request(app).get(`/api/workspaces/${workspaceId}/projects`)).status).toBe(401);
    expect((await request(app).post(`/api/projects/${project.id}/join`)).status).toBe(401);
  });
});

describe('real-time project events', () => {
  it('reach exactly the authorized audience', async () => {
    const { owner, alice, bob, carol, workspaceId } = await setup();
    const [ownerConn, aliceConn, bobConn, carolConn] = await Promise.all([owner, alice, bob, carol].map(harness.connect));

    // Private project: the creator and the workspace manager hear about it; nobody else.
    const ownerSees = nextEvent<{ project: Project }>(ownerConn.socket, 'project:created');
    const aliceSees = nextEvent<{ project: Project }>(aliceConn.socket, 'project:created');
    const bobLeak = collect(bobConn.socket, 'project:created', 600);
    const secret = await newProject(alice, workspaceId, { visibility: 'PRIVATE', name: 'Quiet' });
    expect((await ownerSees).project).toMatchObject({ id: secret.id, name: 'Quiet', memberCount: 1 });
    expect((await aliceSees).project.id).toBe(secret.id);
    expect((await ownerSees).project).not.toHaveProperty('myRole');
    expect(await bobLeak).toHaveLength(0);

    // Adding bob: bob is told; carol hears nothing at all about the project.
    const carolEvents = Promise.all(
      ['project:member_added', 'project:updated', 'project:created'].map((e) => collect(carolConn.socket, e, 800))
    );
    const bobAdded = nextEvent<{ member: { userId: string } }>(bobConn.socket, 'project:member_added');
    const bobUpdated = nextEvent<{ project: Project }>(bobConn.socket, 'project:updated', (p) => p.project.id === secret.id);
    await addMember(alice, secret.id, bob);
    expect((await bobAdded).member.userId).toBe(bob.user.id);
    expect((await bobUpdated).project).toMatchObject({ memberCount: 2 });
    expect((await carolEvents).flat()).toHaveLength(0);

    // Public project: everyone in the workspace sees it.
    const carolSeesPublic = nextEvent<{ project: Project }>(carolConn.socket, 'project:created');
    const open = await newProject(alice, workspaceId, { name: 'Loud' });
    expect((await carolSeesPublic).project.id).toBe(open.id);

    // PUBLIC → PRIVATE: non-members are told to drop it; members just get the update.
    await addMember(alice, open.id, bob);
    const carolDrop = nextEvent<{ projectId: string }>(carolConn.socket, 'project:removed');
    const bobUpdate = nextEvent<{ project: Project }>(bobConn.socket, 'project:updated', (p) => p.project.visibility === 'PRIVATE');
    const bobNoDrop = collect(bobConn.socket, 'project:removed', 600);
    expect((await api(alice).patch(`/api/projects/${open.id}`, { visibility: 'PRIVATE' })).status).toBe(200);
    expect((await carolDrop).projectId).toBe(open.id);
    expect((await bobUpdate).project.id).toBe(open.id);
    expect(await bobNoDrop).toHaveLength(0);
  });

  it('removal from a private project revokes its channel rooms immediately', async () => {
    const { alice, bob, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId, { visibility: 'PRIVATE' });
    await addMember(alice, project.id, bob);
    const channel = await newChannel(alice, workspaceId, { projectId: project.id });
    expect((await api(alice).post(`/api/channels/${channel.id}/members`, { userId: bob.user.id })).status).toBe(201);

    const [aliceConn, bobConn] = await Promise.all([harness.connect(alice), harness.connect(bob)]);
    expect(bobConn.channelIds).toContain(channel.id);

    const projectRemoved = nextEvent<{ projectId: string }>(bobConn.socket, 'project:removed');
    const conversationRemoved = nextEvent<{ channelId: string }>(bobConn.socket, 'conversation:removed');
    const aliceSeesRemoval = nextEvent<{ userId: string }>(aliceConn.socket, 'project:member_removed');
    expect((await api(alice).del(`/api/projects/${project.id}/members/${bob.user.id}`)).status).toBe(200);
    expect((await projectRemoved).projectId).toBe(project.id);
    expect((await conversationRemoved).channelId).toBe(channel.id);
    expect((await aliceSeesRemoval).userId).toBe(bob.user.id);
    expect(await prisma.channelMember.count({ where: { channelId: channel.id, userId: bob.user.id } })).toBe(0);

    const leaked = collect(bobConn.socket, 'message:received', 600);
    expect((await emitAck(aliceConn.socket, 'message:send', { channelId: channel.id, content: 'after removal' })).ok).toBe(true);
    expect(await leaked).toHaveLength(0);
    expect((await emitAck(bobConn.socket, 'message:send', { channelId: channel.id, content: 'still here?' })).ok).toBe(false);
  });

  it('channel members are told when their channel moves between project and workspace', async () => {
    const { alice, bob, workspaceId } = await setup();
    const project = await newProject(alice, workspaceId);
    const channel = await newChannel(alice, workspaceId);
    expect((await api(alice).post(`/api/channels/${channel.id}/members`, { userId: bob.user.id })).status).toBe(201);
    const bobConn = await harness.connect(bob);

    const moved = nextEvent<{ channelId: string; projectId: string | null }>(bobConn.socket, 'channel:project_changed');
    const added = nextEvent<{ channel: { id: string } }>(bobConn.socket, 'project:channel_added');
    expect((await api(alice).post(`/api/projects/${project.id}/channels`, { channelId: channel.id })).status).toBe(200);
    expect(await moved).toMatchObject({ channelId: channel.id, projectId: project.id });
    expect((await added).channel.id).toBe(channel.id);

    const back = nextEvent<{ projectId: string | null }>(bobConn.socket, 'channel:project_changed');
    expect((await api(alice).del(`/api/projects/${project.id}/channels/${channel.id}`)).status).toBe(200);
    expect((await back).projectId).toBeNull();
  });
});
