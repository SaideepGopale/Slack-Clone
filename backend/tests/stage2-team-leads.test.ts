import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { ensureSharedWorkspace, reconcileSharedWorkspace, SHARED_CHANNELS } from '../lib/sharedWorkspace';

vi.mock('../utils/mailer', () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPasswordEmail: vi.fn().mockResolvedValue(undefined),
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));
import { sendResetPasswordEmail } from '../utils/mailer';
import { createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, createTeamLead } from './helpers';

/**
 * Stage 2 (T.20) — Company Admin provisions Team Leads; each Team Lead
 * activates once with a single-use link + temporary password and then signs
 * in through the existing, unchanged login. Disposable test database only.
 */
const TL = '/api/team-management';
const ACTIVATE = '/api/account-activation';
const as = (u: { token: string }) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(u.token)).send(body),
});
const tag = () => randomUUID().slice(0, 8);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });
const activate = (body: Record<string, unknown>) => request(app).post(ACTIVATE).send(body);
const tokenFrom = (activationUrl: string) => new URL(activationUrl).hash.replace(/^#token=/, '');

const provision = async (admin: { token: string }, overrides: Record<string, unknown> = {}) => {
  const email = `lead-${tag()}@example.com`;
  const res = await as(admin).post(`${TL}/team-leads`, { email, displayName: 'Priya Lead', teamLabel: 'Design', ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    res,
    email: res.body.credentials.loginId as string,
    userId: res.body.teamLead.id as string,
    invitationId: res.body.teamLead.invitation.id as string,
    token: tokenFrom(res.body.credentials.activationUrl),
    temporaryPassword: res.body.credentials.temporaryPassword as string,
  };
};
const NEW_PASSWORD = 'a-Strong-permanent-pass-1';
const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('Stage 2 — provisioning Team Leads', () => {
  it('a Company Admin provisions a Team Lead: a normal account with the Team Lead grant (never platform ADMIN), credentials shown once', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const email = `Lead.${tag()}@Example.com`;
    const res = await as(admin).post(`${TL}/team-leads`, {
      email, displayName: 'Priya Sharma', teamLabel: 'Design',
      // Forged fields are ignored.
      role: 'ADMIN', tier: 'MEMBER', status: 'SUSPENDED', password: 'chosen-by-attacker', isAdmin: true,
    });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const { teamLead, credentials } = res.body;
    expect(credentials.loginId).toBe(email.toLowerCase());
    expect(credentials.temporaryPassword).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
    expect(credentials.activationUrl).toMatch(/\/activate#token=[A-Za-z0-9_-]{43}$/);
    expect(new Date(credentials.expiresAt).getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);
    expect(teamLead).toMatchObject({ loginId: email.toLowerCase(), displayName: 'Priya Sharma', status: 'SUSPENDED', invitation: { status: 'PENDING', teamLabel: 'Design' } });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: teamLead.id }, include: { accountTier: true } });
    expect(user.role).toBe('USER');
    expect(user.status).toBe('SUSPENDED'); // T.21: suspended until activation
    expect(user.accountTier).toMatchObject({ tier: 'TEAM_LEAD', grantedById: admin.user.id });
    expect(await bcrypt.compare('chosen-by-attacker', user.password)).toBe(false);

    // Listed afterwards — without any credential, token or hash.
    const list = await as(admin).get(`${TL}/team-leads`);
    expect(list.status).toBe(200);
    const listed = list.body.teamLeads.find((t: { id: string }) => t.id === teamLead.id);
    expect(listed).toMatchObject({ loginId: email.toLowerCase(), invitation: { status: 'PENDING' } });
    const json = JSON.stringify(list.body);
    for (const secret of [credentials.temporaryPassword, tokenFrom(credentials.activationUrl), 'tokenHash', 'tempPasswordHash', 'credentialFingerprint', '$2a$', '$2b$']) {
      expect(json).not.toContain(secret);
    }
  });

  it('only a Company Admin can provision, list, revoke or reissue — Members and Team Leads get 403 and nothing is created', async () => {
    const member = await createAndLoginUser();
    const lead = await createTeamLead();
    const email = `nope-${tag()}@example.com`;
    for (const actor of [member, lead]) {
      expect((await as(actor).post(`${TL}/team-leads`, { email, displayName: 'X' })).status).toBe(403);
      expect((await as(actor).get(`${TL}/team-leads`)).status).toBe(403);
      expect((await as(actor).post(`${TL}/invitations/${randomUUID()}/revoke`)).status).toBe(403);
      expect((await as(actor).post(`${TL}/team-leads/${actor.user.id}/reissue`)).status).toBe(403);
    }
    expect((await request(app).post(`${TL}/team-leads`).send({ email })).status).toBe(401);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.accountTierGrant.findUnique({ where: { userId: member.user.id } })).toBeNull();
  });

  it('refuses duplicates safely: existing accounts (any case), system accounts, and a concurrent double submit', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const existing = await createAndLoginUser();
    for (const email of [existing.user.email, existing.user.email.toUpperCase(), 'system@smartconnect.internal']) {
      const res = await as(admin).post(`${TL}/team-leads`, { email, displayName: 'Dup' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already/i);
    }
    expect(await prisma.accountInvitation.count({ where: { userId: existing.user.id } })).toBe(0);
    expect(await prisma.accountTierGrant.findUnique({ where: { userId: existing.user.id } })).toBeNull();

    const email = `race-${tag()}@example.com`;
    const results = await Promise.all(Array.from({ length: 4 }, () => as(admin).post(`${TL}/team-leads`, { email, displayName: 'Race' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await prisma.accountInvitation.count({ where: { user: { email } } })).toBe(1);

    for (const bad of [{ email: 'not-an-email' }, { email: `${'a'.repeat(250)}@x.io` }, { email: ['x@y.io'] }, {}]) {
      expect((await as(admin).post(`${TL}/team-leads`, { displayName: 'Bad', ...bad })).status).toBe(400);
    }
  });

  it('stores only hashes — no plaintext link token or temporary password in any row, audit entry or the account password', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    const invitation = await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } });
    expect(invitation.tokenHash).toBe(sha256(lead.token));
    expect(invitation.tokenHash).not.toContain(lead.token);
    expect(invitation.tempPasswordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare(lead.temporaryPassword, invitation.tempPasswordHash!)).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: lead.userId } });
    expect(await bcrypt.compare(lead.temporaryPassword, user.password)).toBe(false); // the login can never accept it

    const rows = await prisma.$queryRaw<{ dump: string }[]>`
      SELECT row_to_json(i)::text AS dump FROM "AccountInvitation" i WHERE i.id = ${lead.invitationId}
      UNION ALL SELECT row_to_json(u)::text FROM "User" u WHERE u.id = ${lead.userId}
      UNION ALL SELECT row_to_json(a)::text FROM "AuditLog" a WHERE a."targetId" = ${lead.userId}`;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const { dump } of rows) {
      expect(dump).not.toContain(lead.token);
      expect(dump).not.toContain(lead.temporaryPassword);
    }
  });
});

describe('Stage 2 — activation', () => {
  it('activates with the right link token and temporary password; the new password then works through the normal login and the temporary one never does', async () => {
    const { workspaceId: collabId, channelIds } = await ensureSharedWorkspace(); // as the server does at boot
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    expect((await login(lead.email, lead.temporaryPassword)).status).toBe(401); // before activation

    const res = await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activated: true, loginId: lead.email });
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(JSON.stringify(res.body)).not.toMatch(/token|eyJ/); // no session is issued here

    expect((await login(lead.email, lead.temporaryPassword)).status).toBe(401);
    const session = await login(lead.email, NEW_PASSWORD);
    expect(session.status).toBe(200);
    expect(session.body.user.role).toBe('USER');

    const invitation = await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } });
    expect(invitation).toMatchObject({ status: 'ACCEPTED', tempPasswordHash: null });
    expect(invitation.acceptedAt).toBeInstanceOf(Date);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: lead.userId } })).status).toBe('ACTIVE');

    // SmartConnect Collab access with every default channel, and Team Lead powers (Stage 1).
    expect(await prisma.channelMember.count({ where: { userId: lead.userId, channelId: { in: channelIds } } })).toBe(SHARED_CHANNELS.length);
    const workspaces = await as({ token: session.body.token }).get('/api/workspaces');
    expect(workspaces.body.map((w: { id: string }) => w.id)).toContain(collabId);
    expect(await prisma.channelMember.count({ where: { userId: lead.userId, channelId: { in: channelIds } } })).toBe(SHARED_CHANNELS.length);
    expect((await as({ token: session.body.token }).post('/api/workspaces', { name: `Lead team ${tag()}` })).status).toBe(201);
    const listed = (await as(admin).get(`${TL}/team-leads`)).body.teamLeads.find((t: { id: string }) => t.id === lead.userId);
    expect(listed.invitation.status).toBe('ACCEPTED');
  });

  it('answers a wrong token and a wrong temporary password identically, and locks the invitation after repeated wrong passwords', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    const wrongToken = await activate({ token: lead.token.slice(0, -4) + 'AAAA', temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD });
    const wrongTemp = await activate({ token: lead.token, temporaryPassword: 'AAAAA-BBBBB-CCCCC-DDDDD', newPassword: NEW_PASSWORD });
    expect(wrongToken.status).toBe(400);
    expect(wrongTemp.status).toBe(400);
    expect(wrongTemp.body).toEqual(wrongToken.body);
    expect(wrongToken.body.error).toMatch(/not valid/);
    expect(JSON.stringify(wrongToken.body)).not.toContain(lead.email);

    for (let i = 1; i < 5; i++) expect((await activate({ token: lead.token, temporaryPassword: `wrong-${i}`, newPassword: NEW_PASSWORD })).status).toBe(400);
    const locked = await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } });
    expect(locked).toMatchObject({ status: 'REVOKED', revokedReason: 'TOO_MANY_ATTEMPTS', failedAttempts: 5, tempPasswordHash: null });
    expect((await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(410);
  });

  it('rejects expired invitations and shows them as Expired', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    await prisma.accountInvitation.update({ where: { id: lead.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
    const listed = (await as(admin).get(`${TL}/team-leads`)).body.teamLeads.find((t: { id: string }) => t.id === lead.userId);
    expect(listed.invitation.status).toBe('EXPIRED');
  });

  it('rejects revoked invitations; only a Company Admin revokes, and only pending invitations', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    const revoke = (actor: { token: string }) => as(actor).post(`${TL}/invitations/${lead.invitationId}/revoke`);
    expect((await revoke(await createTeamLead())).status).toBe(403);
    const res = await revoke(admin);
    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({ id: lead.invitationId, status: 'REVOKED', revokedReason: 'ADMIN' });
    expect((await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } })).tempPasswordHash).toBeNull();
    expect((await revoke(admin)).status).toBe(409);
    expect((await as(admin).post(`${TL}/invitations/${randomUUID()}/revoke`)).status).toBe(404);
    expect((await as(admin).post(`${TL}/invitations/not-a-uuid/revoke`)).status).toBe(404);

    const attempt = await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD });
    expect(attempt.status).toBe(410);
    expect(attempt.body.error).toMatch(/revoked/i);
  });

  it('a consumed invitation cannot be replayed — not even with a different new password', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    const body = { token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD };
    expect((await activate(body)).status).toBe(200);
    expect((await activate(body)).status).toBe(410);
    expect((await activate({ ...body, newPassword: 'another-Strong-pass-2' })).status).toBe(410);
    expect((await login(lead.email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(lead.email, 'another-Strong-pass-2')).status).toBe(401);
  });

  it('concurrent activations: exactly one succeeds and only its password works', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    const passwords = Array.from({ length: 5 }, (_, i) => `concurrent-Pass-${i}-${tag()}`);
    const results = await Promise.all(passwords.map((newPassword) => activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword })));
    const winners = results.map((r, i) => ({ status: r.status, password: passwords[i] })).filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 410)).toHaveLength(4);
    for (const password of passwords) {
      expect((await login(lead.email, password)).status).toBe(password === winners[0].password ? 200 : 401);
    }
  });

  it('refuses inactive accounts, accounts whose password was set another way, and weak new passwords', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });

    // Only an account still awaiting activation (SUSPENDED) can be activated:
    // banned, or reinstated through the existing admin status control, it cannot.
    for (const status of ['BANNED', 'ACTIVE'] as const) {
      const other = await provision(admin);
      await prisma.user.update({ where: { id: other.userId }, data: { status } });
      expect((await activate({ token: other.token, temporaryPassword: other.temporaryPassword, newPassword: NEW_PASSWORD })).status, status).toBe(403);
      expect((await prisma.accountInvitation.findUniqueOrThrow({ where: { id: other.invitationId } })).status).toBe('PENDING');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: other.userId } })).status).toBe(status);
    }

    // The admin used the existing "Set password" on the pending account: activation must not overwrite it,
    // and the account stays suspended (no sign-in) until an admin decides otherwise.
    const manual = await provision(admin);
    expect((await as(admin).post(`/api/admin/users/${manual.userId}/password`, { password: 'set-by-admin-1' })).status).toBe(200);
    expect((await activate({ token: manual.token, temporaryPassword: manual.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(409);
    expect((await login(manual.email, 'set-by-admin-1')).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: manual.userId } })).status).toBe('SUSPENDED');

    const lead = await provision(admin);
    for (const newPassword of ['short', lead.temporaryPassword, lead.email, lead.email.toUpperCase(), 'x'.repeat(129), 12345678901]) {
      expect((await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword })).status).toBe(400);
    }
    expect((await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } })).failedAttempts).toBe(0);
    for (const body of [{}, { token: 5, temporaryPassword: 'x', newPassword: NEW_PASSWORD }, { token: lead.token }]) {
      expect((await activate(body)).status).toBe(400);
    }
  });

  it('is rate limited per client', async () => {
    process.env.NODE_ENV = 'development';
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await activate({ token: `x${i}`.padEnd(43, 'x'), temporaryPassword: 'x', newPassword: NEW_PASSWORD })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('Stage 2 finalization — suspended until activation (T.21)', () => {
  it('a provisioned account stays SUSPENDED and out of SmartConnect Collab until activation, which makes it ACTIVE atomically', async () => {
    const { workspaceId: collabId } = await ensureSharedWorkspace();
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    const state = async () => ({
      status: (await prisma.user.findUniqueOrThrow({ where: { id: lead.userId } })).status,
      inCollab: !!(await prisma.workspaceMember.findUnique({ where: { userId_workspaceId: { userId: lead.userId, workspaceId: collabId } } })),
      invitation: (await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } })).status,
    });
    await reconcileSharedWorkspace(); // the boot-time reconcile only adds ACTIVE accounts
    expect(await state()).toEqual({ status: 'SUSPENDED', inCollab: false, invitation: 'PENDING' });
    expect((await login(lead.email, lead.temporaryPassword)).status).toBe(401);

    // A refused activation (wrong temporary password) changes nothing.
    expect((await activate({ token: lead.token, temporaryPassword: 'wrong-wrong', newPassword: NEW_PASSWORD })).status).toBe(400);
    expect(await state()).toEqual({ status: 'SUSPENDED', inCollab: false, invitation: 'PENDING' });

    expect((await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await state()).toEqual({ status: 'ACTIVE', inCollab: true, invitation: 'ACCEPTED' });
    expect((await login(lead.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('forgot-password cannot bypass activation: a reset leaves the account suspended and blocks activation', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    vi.mocked(sendResetPasswordEmail).mockClear();
    expect((await request(app).post('/api/auth/forgot-password').send({ email: lead.email })).status).toBe(200);
    expect(sendResetPasswordEmail).toHaveBeenCalledTimes(1);
    const link = new URL(vi.mocked(sendResetPasswordEmail).mock.calls[0][1] as string);
    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ id: link.searchParams.get('id'), token: link.searchParams.get('token'), newPassword: 'reset-by-mail-1' });
    expect(reset.status).toBe(200); // the unchanged reset flow still works…

    const signIn = await login(lead.email, 'reset-by-mail-1');
    expect(signIn.status).toBe(403); // …but the account is still suspended: no session
    expect(signIn.body.token).toBeUndefined();
    expect((await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: lead.userId } })).status).toBe('SUSPENDED');
    expect((await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } })).status).toBe('PENDING');
  });

  it('applies the confirmed defaults: 72-hour expiry, 10-character minimum, lock after 5 wrong temporary passwords', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const before = Date.now();
    const lead = await provision(admin);
    const { expiresAt } = await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } });
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(72 * 3600_000 - 5_000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(72 * 3600_000 + 60_000);
    expect((await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: '123456789' })).status).toBe(400); // 9
    for (let i = 0; i < 5; i++) await activate({ token: lead.token, temporaryPassword: `nope-${i}`, newPassword: NEW_PASSWORD });
    expect(await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } })).toMatchObject({ status: 'REVOKED', revokedReason: 'TOO_MANY_ATTEMPTS' });
    expect((await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: '1234567890' })).status).toBe(410);
  });
});

describe('Stage 2 — reissuing invitations', () => {
  it('a never-activated Team Lead whose invitation expired or was revoked gets a fresh one; never while one is pending or after activation', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    const reissue = () => as(admin).post(`${TL}/team-leads/${lead.userId}/reissue`);
    expect((await reissue()).status).toBe(409); // still pending

    await prisma.accountInvitation.update({ where: { id: lead.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const fresh = await reissue();
    expect(fresh.status).toBe(201);
    expect(fresh.headers['cache-control']).toMatch(/no-store/);
    const newToken = tokenFrom(fresh.body.credentials.activationUrl);
    expect(newToken).not.toBe(lead.token);
    expect(fresh.body.credentials.temporaryPassword).not.toBe(lead.temporaryPassword);
    expect((await prisma.accountInvitation.findUniqueOrThrow({ where: { id: lead.invitationId } })).status).toBe('REVOKED');
    expect(await prisma.accountInvitation.count({ where: { userId: lead.userId, status: 'PENDING' } })).toBe(1);

    expect((await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(410);
    expect((await activate({ token: newToken, temporaryPassword: fresh.body.credentials.temporaryPassword, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await reissue()).status).toBe(409); // activated
    const plain = await createAndLoginUser();
    expect((await as(admin).post(`${TL}/team-leads/${plain.user.id}/reissue`)).status).toBe(404); // not a provisioned Team Lead
  });
});

describe('Stage 2 — existing behaviour is unchanged', () => {
  it('existing Admin Create User and Company Admin login work exactly as before, and create no tier or invitation', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const relogin = await login(admin.user.email, 'Password123!');
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.role).toBe('ADMIN');
    expect((await as({ token: relogin.body.token }).get('/api/admin/stats')).status).toBe(200);

    const t = tag();
    const created = await as(admin).post('/api/admin/users', { username: `s2_${t}`, loginId: `s2_${t}@example.com`, password: `pass-${t}` });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ role: 'USER', status: 'ACTIVE' });
    expect((await login(`s2_${t}@example.com`, `pass-${t}`)).status).toBe(200);
    expect(await prisma.accountTierGrant.findUnique({ where: { userId: created.body.id } })).toBeNull();
    expect(await prisma.accountInvitation.count({ where: { userId: created.body.id } })).toBe(0);
  });

  it('Stage 1 still holds: provisioned Team Leads create workspaces, Members cannot, and nobody reaches another team\'s private workspace', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const lead = await provision(admin);
    await activate({ token: lead.token, temporaryPassword: lead.temporaryPassword, newPassword: NEW_PASSWORD });
    const leadSession = { token: (await login(lead.email, NEW_PASSWORD)).body.token as string };
    const otherLead = await createTeamLead();
    const { workspaceId } = await createWorkspace(otherLead as TestUser);
    const member = await createAndLoginUser();

    expect((await as(member).post('/api/workspaces', { name: `m-${tag()}` })).status).toBe(403);
    expect((await as(leadSession).get(`/api/workspaces/${workspaceId}/channels`)).status).toBe(403);
    expect((await as(leadSession).post(`${TL}/team-leads`, { email: `x-${tag()}@example.com`, displayName: 'X' })).status).toBe(403);
  });
});
