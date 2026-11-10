import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser, createTeamLead, grantTier } from './helpers';
import { addToWorkspace, createWorkspace, TestUser } from './collab-helpers';
import { collect, emitAck, nextEvent, useSocketHarness } from './socket-harness';

const harness = useSocketHarness();

const organizationOf = async (workspaceId: string) =>
  (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { organizationId: true } }))!.organizationId!;

const api = (user: TestUser) => ({
  get: (url: string) => request(app).get(url).set(authHeader(user.token)),
  post: (url: string, body: object = {}) => request(app).post(url).set(authHeader(user.token)).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set(authHeader(user.token)).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set(authHeader(user.token)).send(body),
  del: (url: string) => request(app).delete(url).set(authHeader(user.token)),
});

/** An organization with an owner, a second workspace, and two members of the first workspace. */
const setupOrganization = async () => {
  const owner = await createAndLoginUser();
  const alice = await createAndLoginUser();
  const bob = await createAndLoginUser();
  const first = await createWorkspace(owner);
  const organizationId = await organizationOf(first.workspaceId);
  const secondRes = await api(owner).post('/api/workspaces', { name: `Second ${Date.now()}`, organizationId });
  expect(secondRes.status).toBe(201);
  const second = { workspaceId: secondRes.body.workspace.id as string, generalChannelId: secondRes.body.generalChannel.id as string };
  await addToWorkspace(alice, first.workspaceId, [first.generalChannelId]);
  await addToWorkspace(bob, first.workspaceId, [first.generalChannelId]);
  return { owner, alice, bob, organizationId, first, second };
};

describe('hierarchy: organizations own workspaces', () => {
  it('creating a workspace creates its organization with the creator as OWNER', async () => {
    const owner = await createAndLoginUser();
    const member = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner, 'Acme Product');
    await addToWorkspace(member, workspaceId);

    const list = await api(owner).get('/api/workspaces');
    const entry = list.body.find((w: { id: string }) => w.id === workspaceId);
    expect(entry).toMatchObject({
      isOwner: true,
      organizationRole: 'OWNER',
      organization: { name: 'Acme Product', isDefault: false },
      capabilities: { canManage: true },
    });

    const orgs = await api(owner).get('/api/organizations');
    expect(orgs.body.find((o: { id: string }) => o.id === entry.organization.id)).toMatchObject({
      myRole: 'OWNER',
      capabilities: { canUpdate: true, canCreateWorkspace: true, canChangeRoles: true, canRemoveMembers: true },
    });

    // A workspace member without an explicit row is an implied organization MEMBER.
    const memberOrgs = await api(member).get('/api/organizations');
    expect(memberOrgs.body.find((o: { id: string }) => o.id === entry.organization.id)).toMatchObject({
      myRole: 'MEMBER',
      capabilities: { canUpdate: false, canCreateWorkspace: false },
    });
    expect((await api(member).get('/api/workspaces')).body.find((w: { id: string }) => w.id === workspaceId).capabilities.canManage).toBe(false);
  });

  it('only organization OWNER/ADMIN can add workspaces to an organization', async () => {
    const { owner, alice, organizationId, first, second } = await setupOrganization();
    // Stage 1: both are Team Leads, so the ORGANIZATION rule (not the tier rule) is what's tested here.
    const outsider = await createTeamLead();
    await grantTier(alice.user.id);
    expect(await organizationOf(second.workspaceId)).toBe(organizationId);
    expect((await api(alice).post('/api/workspaces', { name: 'Nope', organizationId })).status).toBe(403);
    expect((await api(outsider).post('/api/workspaces', { name: 'Nope', organizationId })).status).toBe(404);
    expect((await api(owner).post('/api/workspaces', { name: 'Bad', organizationId: 'not-a-uuid' })).status).toBe(400);

    const ownerView = await api(owner).get(`/api/organizations/${organizationId}`);
    expect(ownerView.body.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([first.workspaceId, second.workspaceId].sort());
    // Members only see the workspaces they belong to.
    const aliceView = await api(alice).get(`/api/organizations/${organizationId}`);
    expect(aliceView.body.workspaces.map((w: { id: string }) => w.id)).toEqual([first.workspaceId]);
  });

  it('isolates organizations from each other', async () => {
    const a = await setupOrganization();
    const b = await setupOrganization();
    const intruder = a.alice;
    for (const res of [
      await api(intruder).get(`/api/organizations/${b.organizationId}`),
      await api(intruder).get(`/api/organizations/${b.organizationId}/members`),
      await api(intruder).patch(`/api/organizations/${b.organizationId}`, { name: 'pwned' }),
      await api(intruder).patch(`/api/organizations/${b.organizationId}/members/${b.bob.user.id}`, { role: 'ADMIN' }),
      await api(intruder).del(`/api/organizations/${b.organizationId}/members/${b.bob.user.id}`),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await api(intruder).get('/api/organizations')).body.map((o: { id: string }) => o.id)).not.toContain(b.organizationId);
  });
});

describe('organization management', () => {
  it('rename is limited to OWNER/ADMIN and broadcast only to the organization', async () => {
    const { owner, alice, organizationId } = await setupOrganization();
    const outsider = await setupOrganization();
    const aliceConn = await harness.connect(alice);
    const outsiderConn = await harness.connect(outsider.alice);

    expect((await api(alice).patch(`/api/organizations/${organizationId}`, { name: 'Mine now' })).status).toBe(403);
    expect((await api(owner).patch(`/api/organizations/${organizationId}`, { name: '' })).status).toBe(400);

    const leaked = collect(outsiderConn.socket, 'organization:updated', 800);
    const seen = nextEvent<{ id: string; name: string }>(aliceConn.socket, 'organization:updated');
    const res = await api(owner).patch(`/api/organizations/${organizationId}`, { name: 'Renamed Org' });
    expect(res.status).toBe(200);
    expect(await seen).toMatchObject({ id: organizationId, name: 'Renamed Org' });
    expect(await leaked).toHaveLength(0);
  });

  it('lists explicit and derived members; only the OWNER changes roles', async () => {
    const { owner, alice, bob, organizationId } = await setupOrganization();
    await grantTier(alice.user.id); // Stage 1: only Team Leads can be made organization admins
    const members = await api(alice).get(`/api/organizations/${organizationId}/members`);
    const byId = Object.fromEntries(members.body.members.map((m: { id: string }) => [m.id, m]));
    expect(byId[owner.user.id]).toMatchObject({ role: 'OWNER', explicit: true });
    expect(byId[alice.user.id]).toMatchObject({ role: 'MEMBER', explicit: false });
    expect(byId[bob.user.id]).toMatchObject({ role: 'MEMBER' });

    const search = await api(owner).get(`/api/organizations/${organizationId}/members?q=${alice.user.username.slice(-6)}`);
    expect(search.body.members.map((m: { id: string }) => m.id)).toEqual([alice.user.id]);

    const role = (actor: TestUser, target: string, value: string) =>
      api(actor).patch(`/api/organizations/${organizationId}/members/${target}`, { role: value });
    expect((await role(alice, bob.user.id, 'ADMIN')).status).toBe(403);
    expect((await role(owner, owner.user.id, 'MEMBER')).status).toBe(403);
    expect((await role(owner, alice.user.id, 'OWNER')).status).toBe(400);
    expect((await role(owner, (await createAndLoginUser()).user.id, 'ADMIN')).status).toBe(404);
    expect((await role(owner, alice.user.id, 'ADMIN')).body).toMatchObject({ role: 'ADMIN' });

    // A promoted ADMIN can manage the organization but not change roles.
    expect((await api(alice).patch(`/api/organizations/${organizationId}`, { name: 'By Alice' })).status).toBe(200);
    expect((await role(alice, bob.user.id, 'ADMIN')).status).toBe(403);
  });

  it('removing an organization member detaches every workspace with immediate revocation', async () => {
    const { owner, alice, organizationId, first, second } = await setupOrganization();
    const carol = await createAndLoginUser();
    await addToWorkspace(carol, first.workspaceId, [first.generalChannelId]);
    await addToWorkspace(carol, second.workspaceId, [second.generalChannelId]);
    await grantTier(alice.user.id); // Stage 1: only Team Leads can be made organization admins
    await api(owner).patch(`/api/organizations/${organizationId}/members/${alice.user.id}`, { role: 'ADMIN' });

    const ownerConn = await harness.connect(owner);
    const carolConn = await harness.connect(carol);
    const removedFrom = new Set<string>();
    carolConn.socket.on('workspace:removed', (p: { workspaceId: string }) => removedFrom.add(p.workspaceId));
    const orgRemoved = nextEvent<{ organizationId: string }>(carolConn.socket, 'organization:removed');

    const res = await api(alice).del(`/api/organizations/${organizationId}/members/${carol.user.id}`);
    expect(res.body).toMatchObject({ removed: true, workspaces: 2 });
    expect(await orgRemoved).toEqual({ organizationId });
    expect(removedFrom).toEqual(new Set([first.workspaceId, second.workspaceId]));

    const leaked = collect(carolConn.socket, 'message:received', 700);
    await emitAck(ownerConn.socket, 'message:send', { channelId: first.generalChannelId, content: 'after removal' });
    expect(await leaked).toHaveLength(0);
    for (const ws of [first, second]) {
      expect((await api(carol).get(`/api/workspaces/${ws.workspaceId}/channels`)).status).toBe(403);
    }
    expect((await api(carol).get('/api/organizations')).body.map((o: { id: string }) => o.id)).not.toContain(organizationId);
  });

  it('protects owners, admins (from admins) and workspace owners from removal', async () => {
    const { owner, alice, bob, organizationId } = await setupOrganization();
    for (const lead of [alice, bob]) await grantTier(lead.user.id); // Stage 1: admins are Team Leads
    await api(owner).patch(`/api/organizations/${organizationId}/members/${alice.user.id}`, { role: 'ADMIN' });
    await api(owner).patch(`/api/organizations/${organizationId}/members/${bob.user.id}`, { role: 'ADMIN' });
    const del = (actor: TestUser, target: TestUser) => api(actor).del(`/api/organizations/${organizationId}/members/${target.user.id}`);
    expect((await del(alice, owner)).status).toBe(403);
    expect((await del(alice, bob)).status).toBe(403); // ADMIN cannot remove ADMIN
    // bob (ADMIN) creates a workspace in the org → owns it → cannot be removed.
    expect((await api(bob).post('/api/workspaces', { name: 'Bobs', organizationId })).status).toBe(201);
    expect((await del(owner, bob)).status).toBe(400);
  });
});

describe('workspace settings and roles', () => {
  it('settings: validated, admin-only updates, broadcast to members only', async () => {
    const { owner, alice, first } = await setupOrganization();
    const outsider = await createAndLoginUser();
    const settings = await api(alice).get(`/api/workspaces/${first.workspaceId}/settings`);
    expect(settings.body).toMatchObject({ myRole: 'MEMBER', capabilities: { canUpdateSettings: false, canCreateChannel: true } });
    expect((await api(outsider).get(`/api/workspaces/${first.workspaceId}/settings`)).status).toBe(403);
    expect((await api(alice).patch(`/api/workspaces/${first.workspaceId}`, { name: 'x' })).status).toBe(403);
    for (const bad of [{ name: '' }, { description: 'x'.repeat(501) }, { channelCreationPolicy: 'EVERYONE' }, {}]) {
      expect((await api(owner).patch(`/api/workspaces/${first.workspaceId}`, bad)).status).toBe(400);
    }

    const aliceConn = await harness.connect(alice);
    const outsiderConn = await harness.connect(outsider);
    const leaked = collect(outsiderConn.socket, 'workspace:updated', 700);
    const seen = nextEvent<{ id: string; name: string }>(aliceConn.socket, 'workspace:updated');
    const res = await api(owner).patch(`/api/workspaces/${first.workspaceId}`, {
      name: 'Design Studio',
      description: 'Where design happens',
      channelCreationPolicy: 'ADMINS',
    });
    expect(res.body).toMatchObject({ name: 'Design Studio', description: 'Where design happens', channelCreationPolicy: 'ADMINS' });
    expect(await seen).toMatchObject({ id: first.workspaceId, name: 'Design Studio' });
    expect(await leaked).toHaveLength(0);
  });

  it('channelCreationPolicy=ADMINS restricts channel creation to workspace admins', async () => {
    const { owner, alice, first } = await setupOrganization();
    const create = (actor: TestUser) => api(actor).post('/api/channels', { workspaceId: first.workspaceId, name: `c-${Date.now()}-${Math.random()}` });
    expect((await create(alice)).status).toBe(201); // default MEMBERS
    await api(owner).patch(`/api/workspaces/${first.workspaceId}`, { channelCreationPolicy: 'ADMINS' });
    expect((await create(alice)).status).toBe(403);
    expect((await create(owner)).status).toBe(201);
    await grantTier(alice.user.id); // Stage 1: only Team Leads can be made workspace admins
    await api(owner).patch(`/api/workspaces/${first.workspaceId}/members/${alice.user.id}`, { role: 'ADMIN' });
    expect((await create(alice)).status).toBe(201);
  });

  it('roles: owner/org managers only; owner and self protected; broadcast', async () => {
    const { owner, alice, bob, first } = await setupOrganization();
    const role = (actor: TestUser, target: TestUser, value: string) =>
      api(actor).patch(`/api/workspaces/${first.workspaceId}/members/${target.user.id}`, { role: value });
    await prisma.workspaceMember.update({
      where: { userId_workspaceId: { userId: alice.user.id, workspaceId: first.workspaceId } },
      data: { role: 'ADMIN' },
    });
    expect((await role(alice, bob, 'ADMIN')).status).toBe(403); // workspace admins can't change roles
    expect((await role(owner, owner, 'MEMBER')).status).toBe(403);
    expect((await role(owner, bob, 'SUPERUSER')).status).toBe(400);
    expect((await role(owner, await createAndLoginUser(), 'ADMIN')).status).toBe(404);

    await grantTier(bob.user.id); // Stage 1: only Team Leads can be made workspace admins
    const bobConn = await harness.connect(bob);
    const updated = nextEvent<{ userId: string; role: string }>(bobConn.socket, 'workspace:member_updated');
    expect((await role(owner, bob, 'ADMIN')).body).toMatchObject({ userId: bob.user.id, role: 'ADMIN' });
    expect(await updated).toMatchObject({ userId: bob.user.id, role: 'ADMIN' });
    expect((await api(bob).patch(`/api/workspaces/${first.workspaceId}`, { description: 'bob was here' })).status).toBe(200);
  });

  it('organization managers manage workspaces they are not in — without any content access', async () => {
    const { owner, alice, organizationId, second } = await setupOrganization();
    const member = await createAndLoginUser();
    await addToWorkspace(member, second.workspaceId, [second.generalChannelId]);
    for (const lead of [alice, member]) await grantTier(lead.user.id); // Stage 1: admins are Team Leads
    await api(owner).patch(`/api/organizations/${organizationId}/members/${alice.user.id}`, { role: 'ADMIN' });
    // alice is an organization ADMIN but NOT a member of the second workspace.

    expect((await api(alice).get(`/api/workspaces/${second.workspaceId}/settings`)).body.capabilities.canUpdateSettings).toBe(true);
    expect((await api(alice).patch(`/api/workspaces/${second.workspaceId}`, { description: 'managed by alice' })).status).toBe(200);
    expect((await api(alice).patch(`/api/workspaces/${second.workspaceId}/members/${member.user.id}`, { role: 'ADMIN' })).status).toBe(200);

    expect((await api(alice).get(`/api/workspaces/${second.workspaceId}/channels`)).status).toBe(403);
    expect((await api(alice).get(`/api/channels/${second.generalChannelId}/messages`)).status).toBe(403);
    const aliceConn = await harness.connect(alice);
    expect((await emitAck(aliceConn.socket, 'channel:join', second.generalChannelId)).ok).toBe(false);
    expect((await api(alice).post('/api/channels', { workspaceId: second.workspaceId, name: 'sneaky' })).status).toBe(403);
  });
});

describe('membership upkeep and compatibility', () => {
  it('joins add organization membership; leaving the last workspace removes a plain MEMBER (not an ADMIN)', async () => {
    const owner = await createAndLoginUser();
    const carol = await createAndLoginUser();
    const dave = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);
    const organizationId = await organizationOf(workspaceId);
    const link = await api(owner).get(`/api/workspaces/${workspaceId}/invite-link`);
    const token = new URL(link.body.url).searchParams.get('token');
    for (const u of [carol, dave]) {
      await api(u).post('/api/workspaces/join', { token });
      const requests = await api(owner).get(`/api/workspaces/${workspaceId}/requests`);
      const mine = requests.body.find((r: { user: { id: string } }) => r.user.id === u.user.id);
      expect((await api(owner).put(`/api/workspaces/${workspaceId}/requests/${mine.id}`, { action: 'APPROVE' })).status).toBe(200);
    }
    const rowOf = (u: TestUser) => prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: u.user.id } } });
    expect(await rowOf(carol)).toMatchObject({ role: 'MEMBER' });
    await grantTier(dave.user.id); // Stage 1: only Team Leads can be made organization admins
    await api(owner).patch(`/api/organizations/${organizationId}/members/${dave.user.id}`, { role: 'ADMIN' });

    await api(carol).post(`/api/workspaces/${workspaceId}/leave`);
    await api(dave).post(`/api/workspaces/${workspaceId}/leave`);
    expect(await rowOf(carol)).toBeNull();
    expect(await rowOf(dave)).toMatchObject({ role: 'ADMIN' });
  });

  it('attaches an organization lazily to a workspace created without one (frozen tooling path)', async () => {
    const owner = await createAndLoginUser();
    const member = await createAndLoginUser();
    const workspace = await prisma.workspace.create({
      data: { name: 'Legacy WS', slug: `legacy-${Date.now()}`, ownerId: owner.user.id },
    });
    await prisma.workspaceMember.createMany({
      data: [
        { userId: owner.user.id, workspaceId: workspace.id, role: 'ADMIN' },
        { userId: member.user.id, workspaceId: workspace.id, role: 'MEMBER' },
      ],
    });
    const list = await api(owner).get('/api/workspaces');
    const entry = list.body.find((w: { id: string }) => w.id === workspace.id);
    expect(entry.organization).toMatchObject({ name: 'Legacy WS' });
    const roles = await prisma.organizationMember.findMany({ where: { organizationId: entry.organization.id } });
    expect(Object.fromEntries(roles.map((r) => [r.userId, r.role]))).toEqual({
      [owner.user.id]: 'OWNER',
      [member.user.id]: 'MEMBER',
    });
  });

  it('the Default Organization grants implicit membership and cannot lose members', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);
    const organizationId = await organizationOf(workspaceId);
    await prisma.workspace.update({ where: { id: workspaceId }, data: { isDefault: true } });
    await prisma.organization.update({ where: { id: organizationId }, data: { isDefault: true } });
    try {
      const newcomer = await createAndLoginUser(); // no rows anywhere — like a fresh signup
      const orgs = await api(newcomer).get('/api/organizations');
      expect(orgs.body.find((o: { id: string }) => o.id === organizationId)).toMatchObject({ isDefault: true, myRole: 'MEMBER' });
      expect((await api(newcomer).get(`/api/organizations/${organizationId}`)).status).toBe(200);
      expect((await api(newcomer).patch(`/api/organizations/${organizationId}`, { name: 'x' })).status).toBe(403);
      expect((await api(owner).del(`/api/organizations/${organizationId}/members/${newcomer.user.id}`)).status).toBe(400);
    } finally {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { isDefault: false } });
      await prisma.organization.update({ where: { id: organizationId }, data: { isDefault: false } });
    }
  });

  it('existing workspace creation (no organizationId) keeps working exactly as before — for Team Leads (Stage 1)', async () => {
    const user = await createTeamLead();
    const res = await api(user).post('/api/workspaces', { name: 'Plain' });
    expect(res.status).toBe(201);
    expect(res.body.generalChannel).toMatchObject({ name: 'General' });
    expect(res.body.workspace.organizationId).toBeTruthy();
  });
});
