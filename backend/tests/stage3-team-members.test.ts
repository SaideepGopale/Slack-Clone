import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { ensureSharedWorkspace, reconcileSharedWorkspace } from '../lib/sharedWorkspace';
import { addToWorkspace, createWorkspace, seedMessage, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, createTeamLead } from './helpers';
import { emitAck, useSocketHarness } from './socket-harness';

/**
 * Stage 3 (T.22) — Team Leads run their own workspaces and provision ordinary
 * Members into them (single-use activation, SUSPENDED until activated, reusing
 * the Stage 2 mechanism); existing accounts join through the existing
 * invitation flows. Every rule is enforced server-side. Disposable DB only.
 */
const { connect } = useSocketHarness();
const as = (u: { token: string }) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(u.token)).send(body),
  patch: (path: string, body: object = {}) => request(app).patch(path).set(authHeader(u.token)).send(body),
  put: (path: string, body: object = {}) => request(app).put(path).set(authHeader(u.token)).send(body),
  del: (path: string) => request(app).delete(path).set(authHeader(u.token)),
});
const tag = () => randomUUID().slice(0, 8);
const NEW_PASSWORD = 'member-Permanent-pass-1';
const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });
const activate = (body: Record<string, unknown>) => request(app).post('/api/account-activation').send(body);
const tokenFrom = (url: string) => new URL(url).hash.replace(/^#token=/, '');
const invitationsPath = (workspaceId: string) => `/api/workspaces/${workspaceId}/member-invitations`;

/** A Team Lead with a fresh workspace. */
const teamLeadWithWorkspace = async () => {
  const lead = await createTeamLead();
  const ws = await createWorkspace(lead);
  return { lead, ...ws };
};

const provisionMember = async (lead: TestUser, workspaceId: string, overrides: Record<string, unknown> = {}) => {
  const email = `member-${tag()}@example.com`;
  const res = await as(lead).post(invitationsPath(workspaceId), { email, displayName: 'Mia Member', ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    res,
    email: res.body.credentials.loginId as string,
    userId: res.body.invitation.account.id as string,
    invitationId: res.body.invitation.id as string,
    token: tokenFrom(res.body.credentials.activationUrl),
    temporaryPassword: res.body.credentials.temporaryPassword as string,
  };
};

describe('Stage 3 — workspaces and the hierarchy', () => {
  it('a Team Lead creates a workspace with a description; a Member cannot; the hierarchy endpoint tells the UI which is which', async () => {
    const lead = await createTeamLead();
    const member = await createAndLoginUser();
    const admin = await createAndLoginUser({ role: 'ADMIN' });

    const created = await as(lead).post('/api/workspaces', { name: `Team ${tag()}`, description: 'Where the design team works.' });
    expect(created.status).toBe(201);
    expect(created.body.workspace).toMatchObject({ ownerId: lead.user.id, description: 'Where the design team works.' });
    expect((await as(lead).post('/api/workspaces', { name: `Team ${tag()}`, description: 'x'.repeat(501) })).status).toBe(400);
    expect((await as(member).post('/api/workspaces', { name: `Nope ${tag()}`, description: 'nope' })).status).toBe(403);

    expect((await as(lead).get('/api/me/hierarchy')).body).toEqual({ role: 'TEAM_LEAD', canCreateWorkspaces: true, canProvisionMembers: true });
    expect((await as(member).get('/api/me/hierarchy')).body).toEqual({ role: 'MEMBER', canCreateWorkspaces: false, canProvisionMembers: false });
    expect((await as(admin).get('/api/me/hierarchy')).body).toEqual({ role: 'COMPANY_ADMIN', canCreateWorkspaces: true, canProvisionMembers: false });
    expect((await request(app).get('/api/me/hierarchy')).status).toBe(401);

    // Member counts for the dashboard cards.
    const listed = (await as(lead).get('/api/workspaces')).body.find((w: { id: string }) => w.id === created.body.workspace.id);
    expect(listed._count.members).toBe(1);
    expect(listed.capabilities.canManage).toBe(true);
  });
});

describe('Stage 3 — provisioning Members', () => {
  it('a Team Lead provisions a Member: a SUSPENDED ordinary account, no tier, bound to that workspace, credentials once', async () => {
    const { lead, workspaceId } = await teamLeadWithWorkspace();
    const email = `New.${tag()}@Example.com`;
    const res = await as(lead).post(invitationsPath(workspaceId), {
      email, displayName: 'Nadia Khan',
      // Forged privilege fields are ignored.
      role: 'ADMIN', tier: 'TEAM_LEAD', workspaceRole: 'ADMIN', status: 'ACTIVE', isAdmin: true, workspaceId: randomUUID(),
    });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.credentials).toMatchObject({ loginId: email.toLowerCase() });
    expect(res.body.credentials.temporaryPassword).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
    expect(res.body.invitation).toMatchObject({ status: 'PENDING', account: { loginId: email.toLowerCase(), displayName: 'Nadia Khan', status: 'SUSPENDED' } });

    const account = await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() }, include: { accountTier: true } });
    expect(account).toMatchObject({ role: 'USER', status: 'SUSPENDED', accountTier: null });
    const invitation = await prisma.accountInvitation.findUniqueOrThrow({ where: { id: res.body.invitation.id } });
    expect(invitation).toMatchObject({ intendedTier: 'MEMBER', workspaceId, createdById: lead.user.id });
    expect(invitation.tokenHash).not.toContain(tokenFrom(res.body.credentials.activationUrl));
    expect(await bcrypt.compare(res.body.credentials.temporaryPassword, account.password)).toBe(false);
    // Nothing granted before activation.
    expect(await prisma.workspaceMember.count({ where: { userId: account.id } })).toBe(0);
    expect((await login(email.toLowerCase(), res.body.credentials.temporaryPassword)).status).toBe(401);
  });

  it('only Team Leads who manage the workspace can provision — not Members, not the Company Admin, not another lead, not in Collab', async () => {
    const { lead, workspaceId } = await teamLeadWithWorkspace();
    const member = await createAndLoginUser();
    await addToWorkspace(member, workspaceId);
    const otherLead = await createTeamLead();
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const { workspaceId: collabId } = await ensureSharedWorkspace();
    const email = `nope-${tag()}@example.com`;

    for (const actor of [member, otherLead, admin]) {
      expect((await as(actor).post(invitationsPath(workspaceId), { email })).status).toBe(403);
      expect((await as(actor).get(invitationsPath(workspaceId))).status).toBe(403);
    }
    expect((await as(lead).post(invitationsPath(collabId), { email })).status).toBe(403);
    expect((await as(lead).post(invitationsPath(randomUUID()), { email })).status).toBe(404);
    expect((await as(lead).post(invitationsPath('not-a-uuid'), { email })).status).toBe(404);
    // A Member who owns a legacy workspace still cannot provision (tier, not ownership, decides).
    const legacyOwner = await createAndLoginUser();
    const legacy = await prisma.workspace.create({ data: { name: `legacy-${tag()}`, slug: `legacy-${tag()}`, ownerId: legacyOwner.user.id } });
    await prisma.workspaceMember.create({ data: { userId: legacyOwner.user.id, workspaceId: legacy.id, role: 'ADMIN' } });
    expect((await as(legacyOwner).post(invitationsPath(legacy.id), { email })).status).toBe(403);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('existing accounts are never duplicated: offered the existing-user invitation flow, or told an activation is pending; concurrent submits create one account', async () => {
    const { lead, workspaceId } = await teamLeadWithWorkspace();
    const existing = await createAndLoginUser();
    const offer = await as(lead).post(invitationsPath(workspaceId), { email: existing.user.email.toUpperCase() });
    expect(offer.status).toBe(409);
    expect(offer.body).toMatchObject({ existingAccount: true, user: { id: existing.user.id, username: existing.user.username } });
    expect(JSON.stringify(offer.body)).not.toMatch(/password|\$2[aby]\$/);
    // The existing-user flow: an e-mail invitation through the existing API.
    expect((await as(lead).post(`/api/workspaces/${workspaceId}/invites`, { email: existing.user.email })).status).toBe(201);

    await addToWorkspace(existing, workspaceId);
    const already = await as(lead).post(invitationsPath(workspaceId), { email: existing.user.email });
    expect(already.status).toBe(409);
    expect(already.body).toMatchObject({ alreadyMember: true });

    const pending = await provisionMember(lead, workspaceId);
    const again = await as(lead).post(invitationsPath(workspaceId), { email: pending.email });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ pendingActivation: true });

    const email = `race-${tag()}@example.com`;
    const results = await Promise.all(Array.from({ length: 4 }, () => as(lead).post(invitationsPath(workspaceId), { email })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await prisma.user.count({ where: { email } })).toBe(1);

    for (const bad of [{ email: 'not-an-email' }, { email: `${'a'.repeat(250)}@x.io` }, {}]) {
      expect((await as(lead).post(invitationsPath(workspaceId), bad)).status).toBe(400);
    }
    expect((await as(lead).post(invitationsPath(workspaceId), { email: 'system@smartconnect.internal' })).status).toBe(409);
  });
});

describe('Stage 3 — Member activation and access', () => {
  it('activation makes the Member ACTIVE with SmartConnect Collab and exactly the assigned workspace — nothing else', async () => {
    const { workspaceId: collabId } = await ensureSharedWorkspace();
    const { lead, workspaceId, generalChannelId } = await teamLeadWithWorkspace();
    const { workspaceId: otherWorkspace } = await teamLeadWithWorkspace();
    const m = await provisionMember(lead, workspaceId);
    await reconcileSharedWorkspace();
    expect(await prisma.workspaceMember.count({ where: { userId: m.userId } })).toBe(0); // suspended: nothing yet

    const res = await activate({ token: m.token, temporaryPassword: m.temporaryPassword, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    const account = await prisma.user.findUniqueOrThrow({ where: { id: m.userId }, include: { accountTier: true, workspaces: true } });
    expect(account).toMatchObject({ status: 'ACTIVE', role: 'USER', accountTier: null });
    expect(account.workspaces.map((w) => [w.workspaceId, w.role]).sort()).toEqual([[collabId, 'MEMBER'], [workspaceId, 'MEMBER']].sort());

    const session = { token: (await login(m.email, NEW_PASSWORD)).body.token as string };
    const listed = (await as(session).get('/api/workspaces')).body.map((w: { id: string }) => w.id).sort();
    expect(listed).toEqual([collabId, workspaceId].sort());
    await seedMessage(generalChannelId, workspaceId, lead.user.id, '<p>welcome to the team</p>');
    expect((await as(session).get(`/api/channels/${generalChannelId}/messages`)).status).toBe(200);
    expect((await as(session).get(`/api/workspaces/${otherWorkspace}/channels`)).status).toBe(403);
    // Still a Member: no creating, no provisioning, no invitations.
    expect((await as(session).post('/api/workspaces', { name: `x-${tag()}` })).status).toBe(403);
    expect((await as(session).post(invitationsPath(workspaceId), { email: `y-${tag()}@example.com` })).status).toBe(403);
    expect((await as(session).get(`/api/workspaces/${workspaceId}/invite-link`)).status).toBe(403);
    expect((await as(lead).get(invitationsPath(workspaceId))).body.invitations.find((i: { id: string }) => i.id === m.invitationId).status).toBe('ACCEPTED');
  });

  it('if the inviter no longer manages the workspace, activation still works but grants only SmartConnect Collab', async () => {
    const { workspaceId: collabId } = await ensureSharedWorkspace();
    const owner = await createTeamLead();
    const { workspaceId } = await createWorkspace(owner);
    const coLead = await createTeamLead();
    await prisma.workspaceMember.create({ data: { userId: coLead.user.id, workspaceId, role: 'ADMIN' } });
    const m = await provisionMember(coLead, workspaceId);
    await prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: coLead.user.id, workspaceId } }, data: { role: 'MEMBER' } });
    expect((await activate({ token: m.token, temporaryPassword: m.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await prisma.workspaceMember.findMany({ where: { userId: m.userId } })).map((w) => w.workspaceId)).toEqual([collabId]);
  });

  it('member invitations: revoke and reissue within the lead’s workspace only; expired, revoked and replayed links are refused; concurrent activation is safe', async () => {
    const { lead, workspaceId } = await teamLeadWithWorkspace();
    const { lead: otherLead } = await teamLeadWithWorkspace();
    const m = await provisionMember(lead, workspaceId);
    const revokePath = `${invitationsPath(workspaceId)}/${m.invitationId}/revoke`;
    const reissuePath = `${invitationsPath(workspaceId)}/${m.invitationId}/reissue`;

    expect((await as(otherLead).post(revokePath)).status).toBe(403);
    expect((await as(lead).post(reissuePath)).status).toBe(409); // still pending
    const revoked = await as(lead).post(revokePath);
    expect(revoked.status).toBe(200);
    expect(revoked.body.invitation).toMatchObject({ status: 'REVOKED', revokedReason: 'TEAM_LEAD' });
    expect((await as(lead).post(revokePath)).status).toBe(409);
    expect((await activate({ token: m.token, temporaryPassword: m.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(410);

    const fresh = await as(lead).post(reissuePath);
    expect(fresh.status).toBe(201);
    expect(fresh.body.invitation).toMatchObject({ status: 'PENDING', account: { id: m.userId } });
    const token = tokenFrom(fresh.body.credentials.activationUrl);
    const temporaryPassword = fresh.body.credentials.temporaryPassword as string;
    expect(await prisma.accountInvitation.findFirstOrThrow({ where: { userId: m.userId, status: 'PENDING' } })).toMatchObject({ workspaceId });

    // An invitation of this workspace can't be managed through another workspace's path.
    const { workspaceId: otherWs } = await createWorkspace(lead);
    expect((await as(lead).post(`${invitationsPath(otherWs)}/${fresh.body.invitation.id}/revoke`)).status).toBe(404);

    // Expired.
    const expired = await provisionMember(lead, workspaceId);
    await prisma.accountInvitation.update({ where: { id: expired.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await activate({ token: expired.token, temporaryPassword: expired.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(410);
    const listed = (await as(lead).get(invitationsPath(workspaceId))).body.invitations;
    expect(listed.find((i: { id: string }) => i.id === expired.invitationId).status).toBe('EXPIRED');

    // Concurrent activation of the reissued invitation: exactly one wins; replay refused.
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => activate({ token, temporaryPassword, newPassword: `${NEW_PASSWORD}-${i}` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 410)).toHaveLength(3);
    expect((await activate({ token, temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(410);
    expect(await prisma.workspaceMember.count({ where: { userId: m.userId, workspaceId } })).toBe(1);
  });
});

describe('Stage 3 — existing users, reusable links and isolation', () => {
  it('an existing user joins through a reusable link with approval; the link never creates an account; concurrent approvals are safe', async () => {
    const { lead, workspaceId } = await teamLeadWithWorkspace();
    const existing = await createAndLoginUser();
    const link = await as(lead).get(`/api/workspaces/${workspaceId}/invite-link`);
    const joinToken = new URL(link.body.url).searchParams.get('token')!;

    // A brand-new person cannot turn the reusable link into an account.
    const stranger = { username: `s_${tag()}`, email: `stranger-${tag()}@example.com`, password: 'Password123!' };
    expect((await request(app).post('/api/auth/signup').send({ ...stranger, inviteToken: joinToken })).status).toBe(403);
    expect(await prisma.user.count({ where: { email: stranger.email } })).toBe(0);

    expect((await as(existing).post('/api/workspaces/join', { token: joinToken })).body).toMatchObject({ status: 'pending' });
    const requests = (await as(lead).get(`/api/workspaces/${workspaceId}/requests`)).body;
    const mine = requests.find((r: { user: { id: string } }) => r.user.id === existing.user.id);
    const decisions = await Promise.all(Array.from({ length: 3 }, () => as(lead).put(`/api/workspaces/${workspaceId}/requests/${mine.id}`, { action: 'APPROVE' })));
    expect(decisions.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.workspaceMember.count({ where: { userId: existing.user.id, workspaceId } })).toBe(1);
    expect(await prisma.workspaceMember.findUniqueOrThrow({ where: { userId_workspaceId: { userId: existing.user.id, workspaceId } } })).toMatchObject({ role: 'MEMBER' });

    // Revoked links are refused.
    expect((await as(lead).del(`/api/workspaces/${workspaceId}/invite-link`)).status).toBe(200);
    const other = await createAndLoginUser();
    expect((await as(other).post('/api/workspaces/join', { token: joinToken })).status).toBeGreaterThanOrEqual(400);
  });

  it("a Team Lead cannot manage another lead's workspace, reach its content, or change accounts and tiers", async () => {
    const { lead: leadA, workspaceId, generalChannelId } = await teamLeadWithWorkspace();
    const leadB = await createTeamLead();
    const member = await createAndLoginUser();
    await addToWorkspace(member, workspaceId, [generalChannelId]);
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    await seedMessage(generalChannelId, workspaceId, leadA.user.id, '<p>team A only</p>');

    for (const res of [
      await as(leadB).patch(`/api/workspaces/${workspaceId}`, { name: 'taken' }),
      await as(leadB).post(`/api/workspaces/${workspaceId}/members`, { userId: leadB.user.id }),
      await as(leadB).del(`/api/workspaces/${workspaceId}/members/${member.user.id}`),
      await as(leadB).post(invitationsPath(workspaceId), { email: `x-${tag()}@example.com` }),
      await as(leadB).get(`/api/workspaces/${workspaceId}/channels`),
      await as(leadB).get(`/api/channels/${generalChannelId}/messages`),
      await as(leadB).get(`/api/channels/${generalChannelId}/search?q=team`),
      await as(leadB).get(`/api/workspaces/${workspaceId}/search?q=team`),
    ]) {
      expect([403, 404]).toContain(res.status);
    }
    // Forged socket events: no room, no message.
    const conn = await connect(leadB);
    expect((await emitAck(conn.socket, 'channel:join', generalChannelId)).ok).toBe(false);
    expect((await emitAck(conn.socket, 'message:send', { channelId: generalChannelId, content: 'intrusion' })).ok).toBe(false);
    expect(await prisma.message.count({ where: { channelId: generalChannelId, content: { contains: 'intrusion' } } })).toBe(0);

    // No account-level or tier changes, and never platform ADMIN.
    for (const res of [
      await as(leadA).patch(`/api/admin/users/${member.user.id}/role`),
      await as(leadA).patch(`/api/admin/users/${admin.user.id}/status`, { status: 'SUSPENDED' }),
      await as(leadA).del(`/api/admin/users/${admin.user.id}`),
      await as(leadA).post('/api/team-management/team-leads', { email: `tl-${tag()}@example.com` }),
      await as(leadA).patch(`/api/workspaces/${workspaceId}/members/${member.user.id}`, { role: 'ADMIN' }),
      await as(member).patch(`/api/workspaces/${workspaceId}/members/${member.user.id}`, { role: 'ADMIN' }),
      await as(member).del(`/api/workspaces/${workspaceId}/members/${leadA.user.id}`),
    ]) {
      expect([403, 404]).toContain(res.status);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: member.user.id } })).role).toBe('USER');
    expect(await prisma.accountTierGrant.findUnique({ where: { userId: member.user.id } })).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).status).toBe('ACTIVE');
    // Within their own workspace the lead manages membership as before.
    expect((await as(leadA).del(`/api/workspaces/${workspaceId}/members/${member.user.id}`)).status).toBe(200);
  });
});
