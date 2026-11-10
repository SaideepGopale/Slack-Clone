import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { ensureSharedWorkspace, reconcileSharedWorkspace, SHARED_WORKSPACE_SLUG } from '../lib/sharedWorkspace';
import { ensureWorkspaceOrganization } from '../modules/organizations/organizations.service';
import { addToWorkspace, createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, createTeamLead, grantTier } from './helpers';

/**
 * Stage 1 (T.19) — the company hierarchy, through the real API:
 *   Company Admin (existing platform ADMIN) → Team Lead (TEAM_LEAD tier) → Member (no tier).
 * Only Company Admins and Team Leads create workspaces/organizations; only
 * Team Leads (or Company Admins) can hold elevated workspace/organization
 * roles; nobody can mint a Team Lead or an admin through these APIs; tiers are
 * read from the database on every request. Disposable test database only.
 */
const as = (u: TestUser) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(u.token)).send(body),
  patch: (path: string, body: object = {}) => request(app).patch(path).set(authHeader(u.token)).send(body),
  put: (path: string, body: object = {}) => request(app).put(path).set(authHeader(u.token)).send(body),
  del: (path: string) => request(app).delete(path).set(authHeader(u.token)),
});
const tag = () => randomUUID().slice(0, 8);
const organizationOf = async (workspaceId: string) =>
  (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { organizationId: true } })).organizationId!;
const tierOf = async (userId: string) => (await prisma.accountTierGrant.findUnique({ where: { userId } }))?.tier ?? null;
const workspaceRoleOf = async (userId: string, workspaceId: string) =>
  (await prisma.workspaceMember.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } }))?.role ?? null;
const organizationRoleOf = async (userId: string, organizationId: string) =>
  (await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } }))?.role ?? null;
const joinOrganization = (userId: string, organizationId: string) =>
  prisma.organizationMember.create({ data: { userId, organizationId, role: 'MEMBER' } });

describe('Stage 1 — creating workspaces and organizations', () => {
  it('a Member cannot create a workspace — with or without an organization, whatever the request body claims', async () => {
    const lead = await createTeamLead();
    const { workspaceId } = await createWorkspace(lead);
    const leadOrganizationId = await organizationOf(workspaceId);
    const member = await createAndLoginUser();
    const explicitMember = await createAndLoginUser();
    await grantTier(explicitMember.user.id, 'MEMBER');
    const name = `forbidden-${tag()}`;

    for (const actor of [member, explicitMember]) {
      const plain = await as(actor).post('/api/workspaces', { name });
      expect(plain.status).toBe(403);
      expect(plain.body.error).toMatch(/Team Lead/);
      expect((await as(actor).post('/api/workspaces', { name, organizationId: leadOrganizationId })).status).toBe(403);
      // Forged fields are never trusted: no tier, role, owner or default flag from the body.
      const forged = await as(actor).post('/api/workspaces', {
        name, tier: 'TEAM_LEAD', role: 'ADMIN', ownerId: lead.user.id, isDefault: true, organizationId: leadOrganizationId,
      });
      expect(forged.status).toBe(403);
    }

    expect(await prisma.workspace.count({ where: { name } })).toBe(0);
    expect(await prisma.workspace.count({ where: { ownerId: { in: [member.user.id, explicitMember.user.id] } } })).toBe(0);
    expect(await prisma.organizationMember.count({ where: { userId: { in: [member.user.id, explicitMember.user.id] } } })).toBe(0);
    expect(await tierOf(member.user.id)).toBeNull();
    expect(await tierOf(explicitMember.user.id)).toBe('MEMBER');
  });

  it('a Member cannot create an organization', async () => {
    const member = await createAndLoginUser();
    const name = `forbidden-org-${tag()}`;
    const res = await as(member).post('/api/organizations', { name });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Team Lead/);
    expect(await prisma.organization.count({ where: { name } })).toBe(0);
    expect(await prisma.organizationMember.count({ where: { userId: member.user.id } })).toBe(0);
  });

  it('a Team Lead creates workspaces and organizations and owns exactly what they create', async () => {
    const lead = await createTeamLead();
    const bystander = await createAndLoginUser();

    const ws = await as(lead).post('/api/workspaces', { name: `team-${tag()}`, ownerId: bystander.user.id });
    expect(ws.status).toBe(201);
    expect(ws.body.workspace.ownerId).toBe(lead.user.id);
    expect(await workspaceRoleOf(bystander.user.id, ws.body.workspace.id)).toBeNull();

    const org = await as(lead).post('/api/organizations', { name: `org-${tag()}` });
    expect(org.status).toBe(201);
    expect(await organizationRoleOf(lead.user.id, org.body.id)).toBe('OWNER');
    const inside = await as(lead).post('/api/workspaces', { name: `inside-${tag()}`, organizationId: org.body.id });
    expect(inside.status).toBe(201);
    expect(inside.body.workspace.organizationId).toBe(org.body.id);
    expect(await tierOf(lead.user.id)).toBe('TEAM_LEAD');
  });

  it("a Team Lead cannot create a workspace inside another Team Lead's organization", async () => {
    const leadA = await createTeamLead();
    const leadB = await createTeamLead();
    const { workspaceId } = await createWorkspace(leadA);
    const organizationId = await organizationOf(workspaceId);
    const name = `intrude-${tag()}`;
    const res = await as(leadB).post('/api/workspaces', { name, organizationId });
    expect([403, 404]).toContain(res.status);
    expect(await prisma.workspace.count({ where: { name } })).toBe(0);
  });

  it('the Company Admin (existing platform ADMIN) keeps every existing capability, without needing a tier', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    expect(await tierOf(admin.user.id)).toBeNull();
    expect((await as(admin).post('/api/workspaces', { name: `admin-ws-${tag()}` })).status).toBe(201);
    expect((await as(admin).post('/api/organizations', { name: `admin-org-${tag()}` })).status).toBe(201);
    expect((await as(admin).get('/api/admin/stats')).status).toBe(200);
    expect((await as(admin).get('/api/admin/users')).status).toBe(200);

    // Admin provisioning is unchanged — and what it creates is an ordinary Member.
    const t = tag();
    const created = await as(admin).post('/api/admin/users', { username: `s1_${t}`, loginId: `s1_${t}@example.com`, password: `pass-${t}` });
    expect(created.status).toBe(201);
    expect(await tierOf(created.body.id)).toBeNull();
    const session = await request(app).post('/api/auth/login').send({ email: `s1_${t}@example.com`, password: `pass-${t}` });
    expect(session.status).toBe(200);
    expect((await as({ user: created.body, token: session.body.token } as TestUser).post('/api/workspaces', { name: `x-${t}` })).status).toBe(403);
  });

  it('tiers come from the database on every request — replaying an old request after a downgrade or suspension fails', async () => {
    const lead = await createTeamLead();
    const create = () => as(lead).post('/api/workspaces', { name: `replay-${tag()}` });
    expect((await create()).status).toBe(201);

    await grantTier(lead.user.id, 'MEMBER');
    expect((await create()).status).toBe(403);
    await prisma.accountTierGrant.delete({ where: { userId: lead.user.id } });
    expect((await create()).status).toBe(403);
    expect((await as(lead).post('/api/organizations', { name: `replay-org-${tag()}` })).status).toBe(403);

    await grantTier(lead.user.id, 'TEAM_LEAD');
    expect((await create()).status).toBe(201);
    await prisma.user.update({ where: { id: lead.user.id }, data: { status: 'SUSPENDED' } });
    expect((await create()).status).toBe(403);
  });
});

describe('Stage 1 — workspace and organization roles', () => {
  it('a Member cannot promote themselves or anyone else, or demote the owner', async () => {
    const lead = await createTeamLead();
    const member = await createAndLoginUser();
    const other = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(lead);
    await addToWorkspace(member, workspaceId, [generalChannelId]);
    await addToWorkspace(other, workspaceId, [generalChannelId]);
    const roleUrl = (userId: string) => `/api/workspaces/${workspaceId}/members/${userId}`;

    expect((await as(member).patch(roleUrl(member.user.id), { role: 'ADMIN' })).status).toBe(403);
    expect((await as(member).patch(roleUrl(other.user.id), { role: 'ADMIN' })).status).toBe(403);
    expect((await as(member).patch(roleUrl(lead.user.id), { role: 'MEMBER' })).status).toBe(403);
    expect([400, 403]).toContain((await as(member).patch(roleUrl(member.user.id), { role: 'TEAM_LEAD' })).status);

    expect(await workspaceRoleOf(member.user.id, workspaceId)).toBe('MEMBER');
    expect(await workspaceRoleOf(other.user.id, workspaceId)).toBe('MEMBER');
    expect(await tierOf(member.user.id)).toBeNull();
  });

  it('a Member cannot change organization roles, and is never made an organization admin', async () => {
    const lead = await createTeamLead();
    const member = await createAndLoginUser();
    const other = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(lead);
    const organizationId = await organizationOf(workspaceId);
    for (const u of [member, other]) {
      await addToWorkspace(u, workspaceId, [generalChannelId]);
      await joinOrganization(u.user.id, organizationId);
    }
    const roleUrl = (userId: string) => `/api/organizations/${organizationId}/members/${userId}`;

    expect((await as(member).patch(roleUrl(member.user.id), { role: 'ADMIN' })).status).toBe(403);
    expect((await as(member).patch(roleUrl(other.user.id), { role: 'ADMIN' })).status).toBe(403);
    // Even the organization owner cannot hand a Member organization-level power.
    const byOwner = await as(lead).patch(roleUrl(member.user.id), { role: 'ADMIN' });
    expect(byOwner.status).toBe(403);
    expect(byOwner.body.error).toMatch(/Team Lead/);
    expect((await as(lead).patch(roleUrl(member.user.id), { role: 'OWNER' })).status).toBe(400);

    expect(await organizationRoleOf(member.user.id, organizationId)).toBe('MEMBER');
    expect(await organizationRoleOf(other.user.id, organizationId)).toBe('MEMBER');
  });

  it('a Team Lead makes only other Team Leads workspace or organization admins — never a Member, never a tier', async () => {
    const leadA = await createTeamLead();
    const leadB = await createTeamLead();
    const member = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(leadA);
    const organizationId = await organizationOf(workspaceId);
    for (const u of [leadB, member]) {
      await addToWorkspace(u, workspaceId, [generalChannelId]);
      await joinOrganization(u.user.id, organizationId);
    }
    const wsRole = (userId: string) => `/api/workspaces/${workspaceId}/members/${userId}`;
    const orgRole = (userId: string) => `/api/organizations/${organizationId}/members/${userId}`;

    const memberToAdmin = await as(leadA).patch(wsRole(member.user.id), { role: 'ADMIN' });
    expect(memberToAdmin.status).toBe(403);
    expect(memberToAdmin.body.error).toMatch(/Team Lead/);
    expect(await workspaceRoleOf(member.user.id, workspaceId)).toBe('MEMBER');
    for (const role of ['TEAM_LEAD', 'OWNER', 'COMPANY_ADMIN']) {
      expect((await as(leadA).patch(wsRole(member.user.id), { role })).status).toBe(400);
      expect((await as(leadA).patch(orgRole(member.user.id), { role })).status).toBe(400);
    }

    // Explicit authorization of a fellow Team Lead by the owner is allowed, and reversible.
    expect((await as(leadA).patch(wsRole(leadB.user.id), { role: 'ADMIN' })).status).toBe(200);
    expect(await workspaceRoleOf(leadB.user.id, workspaceId)).toBe('ADMIN');
    expect((await as(leadA).patch(orgRole(leadB.user.id), { role: 'ADMIN' })).status).toBe(200);
    expect((await as(leadA).patch(wsRole(leadB.user.id), { role: 'MEMBER' })).status).toBe(200);
    expect((await as(leadA).patch(orgRole(leadB.user.id), { role: 'MEMBER' })).status).toBe(200);

    expect(await tierOf(member.user.id)).toBeNull();
    expect(await tierOf(leadB.user.id)).toBe('TEAM_LEAD');
  });

  it('a Team Lead cannot create Team Leads or Company Admins through any API', async () => {
    const lead = await createTeamLead();
    const member = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(lead);
    await addToWorkspace(member, workspaceId, [generalChannelId]);

    expect((await as(lead).patch(`/api/workspaces/${workspaceId}/members/${member.user.id}`, { role: 'TEAM_LEAD' })).status).toBe(400);
    expect((await as(lead).patch(`/api/admin/users/${member.user.id}/role`)).status).toBe(403);
    const t = tag();
    expect((await as(lead).post('/api/admin/users', { username: `nope_${t}`, loginId: `nope_${t}@x.io`, password: `pass-${t}` })).status).toBe(403);
    expect((await as(lead).post(`/api/admin/users/${member.user.id}/password`, { password: `pass-${t}` })).status).toBe(403);

    expect(await tierOf(member.user.id)).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: member.user.id } })).role).toBe('USER');
    expect(await prisma.user.count({ where: { username: `nope_${t}` } })).toBe(0);
    expect((await as(member).post('/api/workspaces', { name: `still-member-${t}` })).status).toBe(403);
  });

  it("a Team Lead cannot manage another Team Lead's workspace — as an outsider or as a plain member of it", async () => {
    const leadA = await createTeamLead();
    const leadB = await createTeamLead();
    const member = await createAndLoginUser();
    const target = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(leadA, `A-${tag()}`);
    await addToWorkspace(member, workspaceId, [generalChannelId]);
    const before = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    const attempts = async () => {
      const results = [
        await as(leadB).patch(`/api/workspaces/${workspaceId}`, { name: 'taken over' }),
        await as(leadB).del(`/api/workspaces/${workspaceId}`),
        await as(leadB).post(`/api/workspaces/${workspaceId}/members`, { userId: target.user.id }),
        await as(leadB).del(`/api/workspaces/${workspaceId}/members/${member.user.id}`),
        await as(leadB).patch(`/api/workspaces/${workspaceId}/members/${member.user.id}`, { role: 'ADMIN' }),
        await as(leadB).get(`/api/workspaces/${workspaceId}/invite-link`),
        await as(leadB).get(`/api/workspaces/${workspaceId}/requests`),
        await as(leadB).post(`/api/workspaces/${workspaceId}/invites`, { email: `x-${tag()}@example.com` }),
      ];
      for (const res of results) expect([403, 404]).toContain(res.status);
    };
    await attempts(); // outsider
    await addToWorkspace(leadB, workspaceId, [generalChannelId]);
    await attempts(); // plain member of A's workspace

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(after.name).toBe(before.name);
    expect(after.ownerId).toBe(leadA.user.id);
    expect(await workspaceRoleOf(member.user.id, workspaceId)).toBe('MEMBER');
    expect(await workspaceRoleOf(target.user.id, workspaceId)).toBeNull();
  });

  it("a Team Lead cannot take ownership of another Team Lead's workspace or organization", async () => {
    const leadA = await createTeamLead();
    const leadB = await createTeamLead();
    const { workspaceId, generalChannelId } = await createWorkspace(leadA);
    const organizationId = await organizationOf(workspaceId);
    await addToWorkspace(leadB, workspaceId, [generalChannelId]);
    await joinOrganization(leadB.user.id, organizationId);

    expect((await as(leadB).patch(`/api/workspaces/${workspaceId}`, { ownerId: leadB.user.id })).status).toBe(403);
    // The owner cannot hand ownership over through settings either: ownerId is not a writable field.
    expect((await as(leadA).patch(`/api/workspaces/${workspaceId}`, { ownerId: leadB.user.id })).status).toBe(400);

    // Even once explicitly made an admin, B gains no owner-level power.
    expect((await as(leadA).patch(`/api/workspaces/${workspaceId}/members/${leadB.user.id}`, { role: 'ADMIN' })).status).toBe(200);
    expect((await as(leadB).patch(`/api/workspaces/${workspaceId}`, { ownerId: leadB.user.id, description: 'B was here' })).status).toBe(200);
    expect((await as(leadB).patch(`/api/workspaces/${workspaceId}/members/${leadA.user.id}`, { role: 'MEMBER' })).status).toBe(403);
    expect((await as(leadB).del(`/api/workspaces/${workspaceId}`)).status).toBe(403);
    for (const actor of [leadA, leadB]) {
      expect((await as(actor).patch(`/api/organizations/${organizationId}/members/${leadB.user.id}`, { role: 'OWNER' })).status).toBe(400);
    }

    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).ownerId).toBe(leadA.user.id);
    expect(await organizationRoleOf(leadA.user.id, organizationId)).toBe('OWNER');
    expect(await organizationRoleOf(leadB.user.id, organizationId)).toBe('MEMBER');
  });
});

describe('Stage 1 — Members cannot provision, invite or approve', () => {
  it('a Member of a team workspace cannot add, invite or approve anyone', async () => {
    const lead = await createTeamLead();
    const member = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(lead);
    await addToWorkspace(member, workspaceId, [generalChannelId]);

    expect((await as(member).post(`/api/workspaces/${workspaceId}/members`, { userId: outsider.user.id })).status).toBe(403);
    expect((await as(member).get(`/api/workspaces/${workspaceId}/invite-link`)).status).toBe(403);
    expect((await as(member).post(`/api/workspaces/${workspaceId}/invites`, { email: `y-${tag()}@example.com` })).status).toBe(403);
    expect((await as(member).get(`/api/workspaces/${workspaceId}/requests`)).status).toBe(403);
    expect(await workspaceRoleOf(outsider.user.id, workspaceId)).toBeNull();
  });
});

describe('Stage 1 — no indirect organization privileges', () => {
  it('attaching an organization to a legacy workspace never turns a Member into an organization admin', async () => {
    const owner = await createTeamLead();
    const lead = await createTeamLead();
    const legacyAdmin = await createAndLoginUser();
    const plain = await createAndLoginUser();
    // A workspace without an organization (as created by frozen tooling), with legacy ADMIN rows.
    const workspace = await prisma.workspace.create({ data: { name: `legacy-${tag()}`, slug: `legacy-${tag()}`, ownerId: owner.user.id } });
    await prisma.workspaceMember.createMany({
      data: [
        { userId: owner.user.id, workspaceId: workspace.id, role: 'ADMIN' },
        { userId: lead.user.id, workspaceId: workspace.id, role: 'ADMIN' },
        { userId: legacyAdmin.user.id, workspaceId: workspace.id, role: 'ADMIN' },
        { userId: plain.user.id, workspaceId: workspace.id, role: 'MEMBER' },
      ],
    });

    const organizationId = await ensureWorkspaceOrganization(workspace.id);
    expect(await organizationRoleOf(owner.user.id, organizationId)).toBe('OWNER');
    expect(await organizationRoleOf(lead.user.id, organizationId)).toBe('ADMIN');
    expect(await organizationRoleOf(legacyAdmin.user.id, organizationId)).toBe('MEMBER');
    expect(await organizationRoleOf(plain.user.id, organizationId)).toBe('MEMBER');
    // Existing workspace data is not touched.
    expect(await workspaceRoleOf(legacyAdmin.user.id, workspace.id)).toBe('ADMIN');
  });
});

describe('Stage 1 — SmartConnect Collab', () => {
  it('stays canonical, idempotent and open to every active account, Members included', async () => {
    const first = await ensureSharedWorkspace();
    const second = await ensureSharedWorkspace();
    expect(second.workspaceId).toBe(first.workspaceId);
    // (Other suites flip test workspaces to isDefault on this shared database,
    // so canonicality is asserted through the fixed slug and the stable id.)
    expect(await prisma.workspace.count({ where: { slug: SHARED_WORKSPACE_SLUG } })).toBe(1);
    await reconcileSharedWorkspace();
    expect((await reconcileSharedWorkspace()).membersAdded).toBe(0);

    const member = await createAndLoginUser();
    const list = await as(member).get('/api/workspaces');
    expect(list.status).toBe(200);
    expect(list.body.map((w: { id: string }) => w.id)).toContain(first.workspaceId);
    expect(await workspaceRoleOf(member.user.id, first.workspaceId)).toBe('MEMBER');
    // The bootstrap's system owner is not a Team Lead, and needs no tier.
    const collab = await prisma.workspace.findUniqueOrThrow({ where: { id: first.workspaceId } });
    expect(await tierOf(collab.ownerId)).toBeNull();
  });
});
