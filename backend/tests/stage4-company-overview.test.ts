import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { ensureSharedWorkspace } from '../lib/sharedWorkspace';
import { addToWorkspace, createWorkspace, seedMessage } from './collab-helpers';
import { authHeader, createAndLoginUser, createTeamLead } from './helpers';

/**
 * Stage 4 (T.23) — Company Admin workspace overview: read-only metadata for
 * the Company Admin only; accurate counts; search/filter/sort/pagination;
 * never secrets, never message or file content, never membership.
 */
const BASE = '/api/company-overview';
const as = (u: { token: string }) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(u.token)).send(body),
});
const tag = () => randomUUID().slice(0, 8);
const SECRET_PATTERNS = /tokenHash|tempPasswordHash|credentialFingerprint|"password"|\$2[aby]\$|temporaryPassword|activationUrl/;

/** A Team Lead's workspace with an active member, a suspended member and one pending Member invitation. */
const fixture = async () => {
  const lead = await createTeamLead();
  const name = `Overview ${tag()}`;
  const created = await as(lead).post('/api/workspaces', { name, description: 'Fixture team' });
  const { id: workspaceId } = created.body.workspace;
  const generalChannelId = created.body.generalChannel.id as string;
  const active = await createAndLoginUser();
  const suspended = await createAndLoginUser();
  await addToWorkspace(active, workspaceId, [generalChannelId]);
  await addToWorkspace(suspended, workspaceId, [generalChannelId]);
  await prisma.user.update({ where: { id: suspended.user.id }, data: { status: 'SUSPENDED' } });
  const provisioned = await as(lead).post(`/api/workspaces/${workspaceId}/member-invitations`, { email: `pending-${tag()}@example.com` });
  expect(provisioned.status).toBe(201);
  await seedMessage(generalChannelId, workspaceId, lead.user.id, '<p>TOP SECRET plans</p>', { fileUrl: 'https://res.cloudinary.com/x/raw/upload/workspace-uploads/secret.pdf', fileName: 'secret.pdf' });
  return { lead, name, workspaceId, generalChannelId, active, suspended };
};

describe('Stage 4 — Company Admin workspace overview', () => {
  it('is for the Company Admin only — Team Leads, Members and anonymous callers are refused', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await createTeamLead();
    const member = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(lead);
    const paths = ['/summary', '/workspaces', `/workspaces/${workspaceId}`, '/team-leads'];
    for (const path of paths) {
      expect((await request(app).get(`${BASE}${path}`)).status, path).toBe(401);
      expect((await as(lead).get(`${BASE}${path}`)).status, path).toBe(403);
      expect((await as(member).get(`${BASE}${path}`)).status, path).toBe(403);
      expect((await as(admin).get(`${BASE}${path}`)).status, path).toBe(200);
    }
  });

  it('summary counts match the database (users, Team Leads, members, workspaces, invitations)', async () => {
    await fixture();
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const res = await as(admin).get(`${BASE}/summary`);
    expect(res.status).toBe(200);
    const notSystem = { email: { notIn: ['system@smartconnect.internal', 'deleted-user@system.internal'] } };
    const nonLeads = { ...notSystem, role: 'USER' as const, NOT: { accountTier: { is: { tier: 'TEAM_LEAD' as const } } } };
    const now = new Date();
    expect(res.body).toEqual({
      totalWorkspaces: await prisma.workspace.count(),
      activeWorkspaces: await prisma.workspace.count({ where: { members: { some: { user: { status: 'ACTIVE', ...notSystem } } } } }),
      totalActiveUsers: await prisma.user.count({ where: { ...notSystem, status: 'ACTIVE' } }),
      totalTeamLeads: await prisma.accountTierGrant.count({ where: { tier: 'TEAM_LEAD', user: notSystem } }),
      totalTeamMembers: await prisma.user.count({ where: nonLeads }),
      activeMembers: await prisma.user.count({ where: { ...nonLeads, status: 'ACTIVE' } }),
      suspendedMembers: await prisma.user.count({ where: { ...nonLeads, status: 'SUSPENDED' } }),
      suspendedUsers: await prisma.user.count({ where: { ...notSystem, status: 'SUSPENDED' } }),
      invitations: {
        pending: await prisma.accountInvitation.count({ where: { status: 'PENDING', expiresAt: { gt: now } } }),
        accepted: await prisma.accountInvitation.count({ where: { status: 'ACCEPTED' } }),
        expired: await prisma.accountInvitation.count({ where: { status: 'PENDING', expiresAt: { lte: now } } }),
        revoked: await prisma.accountInvitation.count({ where: { status: 'REVOKED' } }),
      },
    });
    expect(res.body.totalTeamLeads).toBeGreaterThanOrEqual(1);
    expect(res.body.invitations.pending).toBeGreaterThanOrEqual(1);
  });

  it('lists every workspace with accurate per-workspace metadata; Collab is marked as the shared default', async () => {
    const { lead, name, workspaceId } = await fixture();
    const { workspaceId: collabId } = await ensureSharedWorkspace();
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const res = await as(admin).get(`${BASE}/workspaces?q=${encodeURIComponent(name)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
    expect(res.body.workspaces[0]).toMatchObject({
      id: workspaceId, name, description: 'Fixture team', type: 'team', isDefault: false, status: 'active',
      memberCount: 3, activeMemberCount: 2, pendingInvitations: 1,
      owner: { id: lead.user.id, level: 'TEAM_LEAD' }, teamLead: { id: lead.user.id },
    });
    const collab = (await as(admin).get(`${BASE}/workspaces?type=default`)).body.workspaces;
    expect(collab.map((w: { id: string }) => w.id)).toContain(collabId);
    expect(collab.every((w: { isDefault: boolean; type: string; teamLead: unknown }) => w.isDefault && w.type === 'default' && w.teamLead === null)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(SECRET_PATTERNS);
  });

  it('searches, filters, sorts and paginates — with validated, injection-safe parameters', async () => {
    const { lead, name } = await fixture();
    const second = await as(lead).post('/api/workspaces', { name: `${name} B` });
    expect(second.status).toBe(201);
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const list = async (qs: string) => (await as(admin).get(`${BASE}/workspaces?${qs}`)).body;

    const byLead = await list(`teamLeadId=${lead.user.id}&sort=name&order=asc`);
    expect(byLead.workspaces.map((w: { name: string }) => w.name)).toEqual([name, `${name} B`]);
    expect((await list(`teamLeadId=${lead.user.id}&sort=members&order=desc`)).workspaces[0].name).toBe(name);
    expect((await list(`teamLeadId=${lead.user.id}&minMembers=2`)).workspaces.map((w: { name: string }) => w.name)).toEqual([name]);
    expect((await list(`teamLeadId=${lead.user.id}&maxMembers=1`)).workspaces.map((w: { name: string }) => w.name)).toEqual([`${name} B`]);
    expect((await list(`teamLeadId=${lead.user.id}&status=inactive`)).total).toBe(0);
    expect((await list(`teamLeadId=${lead.user.id}&type=default`)).total).toBe(0);

    const p1 = await list(`teamLeadId=${lead.user.id}&sort=name&order=asc&pageSize=1&page=1`);
    const p2 = await list(`teamLeadId=${lead.user.id}&sort=name&order=asc&pageSize=1&page=2`);
    expect([p1.total, p1.totalPages, p2.page]).toEqual([2, 2, 2]);
    expect(p1.workspaces[0].id).not.toBe(p2.workspaces[0].id);

    for (const bad of ['pageSize=0', 'pageSize=101', 'page=-1', 'sort=password', 'order=sideways', 'status=deleted', 'teamLeadId=not-a-uuid', 'minMembers=abc']) {
      expect((await as(admin).get(`${BASE}/workspaces?${bad}`)).status, bad).toBe(400);
    }
    const injection = await as(admin).get(`${BASE}/workspaces?q=${encodeURIComponent(`' OR 1=1 --`)}`);
    expect(injection.status).toBe(200);
    expect(injection.body.total).toBe(0);
  });

  it('workspace detail is read-only metadata: members, roles, statuses and pending invitations — never content, never secrets, never membership', async () => {
    const { lead, workspaceId, generalChannelId, active, suspended } = await fixture();
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const res = await as(admin).get(`${BASE}/workspaces/${workspaceId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: workspaceId, type: 'team', memberCount: 3, teamLead: { id: lead.user.id }, activity: { publicChannels: 1, privateChannels: 0 } });
    expect(res.body.activity.lastMessageAt).toBeTruthy();
    const byId = Object.fromEntries(res.body.members.map((m: { id: string }) => [m.id, m]));
    expect(byId[lead.user.id]).toMatchObject({ workspaceRole: 'OWNER', status: 'ACTIVE', level: 'TEAM_LEAD' });
    expect(byId[active.user.id]).toMatchObject({ workspaceRole: 'MEMBER', status: 'ACTIVE', level: 'MEMBER' });
    expect(byId[suspended.user.id]).toMatchObject({ workspaceRole: 'MEMBER', status: 'SUSPENDED' });
    expect(res.body.pendingInvitations).toHaveLength(1);
    expect(Object.keys(res.body.pendingInvitations[0]).sort()).toEqual(['account', 'createdAt', 'expiresAt', 'id']);

    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(SECRET_PATTERNS);
    expect(json).not.toContain('TOP SECRET');
    expect(json).not.toContain('secret.pdf');
    expect(json).not.toContain('cloudinary');

    // Looking at the overview grants nothing: the admin is still not a member and can't read the channel.
    expect(await prisma.workspaceMember.count({ where: { userId: admin.user.id, workspaceId } })).toBe(0);
    expect((await as(admin).get(`/api/channels/${generalChannelId}/messages`)).status).toBe(403);
    expect((await as(admin).get(`/api/workspaces/${workspaceId}/channels`)).status).toBe(403);
    expect((await as(admin).get(`${BASE}/workspaces/${randomUUID()}`)).status).toBe(404);
    expect((await as(admin).get(`${BASE}/workspaces/not-a-uuid`)).status).toBe(404);
  });

  it('Team Lead overview: managed workspaces, team members and pending invitations per lead; search and pagination', async () => {
    const { lead, name } = await fixture();
    await as(lead).post('/api/workspaces', { name: `${name} second` });
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const res = await as(admin).get(`${BASE}/team-leads?q=${encodeURIComponent(lead.user.username)}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.teamLeads[0]).toMatchObject({ id: lead.user.id, status: 'ACTIVE', level: 'TEAM_LEAD', managedWorkspaces: 2, teamMembers: 2, pendingInvitations: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(SECRET_PATTERNS);
    const page = await as(admin).get(`${BASE}/team-leads?pageSize=1&page=1`);
    expect(page.body.teamLeads).toHaveLength(1);
    expect(page.body.totalPages).toBeGreaterThanOrEqual(1);
    expect((await as(admin).get(`${BASE}/team-leads?pageSize=500`)).status).toBe(400);
  });
});
