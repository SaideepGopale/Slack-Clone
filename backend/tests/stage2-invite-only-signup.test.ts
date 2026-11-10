import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { createWorkspace } from './collab-helpers';
import { authHeader, createAndLoginUser, createTeamLead, uniqueEmail, uniqueUsername } from './helpers';

vi.mock('../utils/mailer', () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPasswordEmail: vi.fn().mockResolvedValue(undefined),
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));
import { sendOtpEmail } from '../utils/mailer';

/**
 * Stage 2 finalization (T.21): public sign-up is invitation-only, enforced on
 * the server in front of the unchanged auth handlers. A valid, pending e-mail
 * invitation for exactly the address being registered is required on every
 * sign-up path (/signup, /signup-request, /verify-otp). Disposable test DB.
 */
const INVITE_ONLY = { error: 'Sign-up is by invitation only. Open the invitation link you received to create your account.' };
const PASSWORD = 'Password123!';
const signup = (body: Record<string, unknown>, path = '/api/auth/signup') => request(app).post(path).send(body);
const originalEnv = process.env.NODE_ENV;
beforeEach(() => vi.mocked(sendOtpEmail).mockClear());
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

/** A Team Lead's workspace whose owner invites people, plus a helper that issues a real pending invitation. */
const inviter = async () => {
  const owner = await createTeamLead();
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  const invite = async (email: string, extra: Record<string, unknown> = {}) =>
    (await prisma.invitation.create({ data: { email: email.trim().toLowerCase(), inviterId: owner.user.id, workspaceId, ...extra } })).token;
  return { owner, workspaceId, generalChannelId, invite };
};

describe('Stage 2 finalization — invitation-only sign-up', () => {
  it('refuses every sign-up path without an invitation, and creates nothing', async () => {
    const email = uniqueEmail();
    for (const path of ['/api/auth/signup', '/api/auth/signup-request', '/api/auth/verify-otp']) {
      const res = await signup({ username: uniqueUsername(), email, password: PASSWORD, code: '123456' }, path);
      expect(res.status, path).toBe(403);
      expect(res.body, path).toEqual(INVITE_ONLY);
    }
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.oTPVerification.count({ where: { email } })).toBe(0);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('gives one identical refusal for unknown, malformed, mismatched, expired, revoked, used and orphaned invitations', async () => {
    const { owner, workspaceId, invite } = await inviter();
    const email = uniqueEmail();
    const other = uniqueEmail();
    // An inviter who has since lost the right to invite (demoted workspace admin).
    const formerAdmin = await createTeamLead();
    await prisma.workspaceMember.create({ data: { userId: formerAdmin.user.id, workspaceId, role: 'ADMIN' } });
    const orphaned = (await prisma.invitation.create({ data: { email, inviterId: formerAdmin.user.id, workspaceId } })).token;
    await prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: formerAdmin.user.id, workspaceId } }, data: { role: 'MEMBER' } });

    const tokens: unknown[] = [
      randomUUID(),
      'not-a-uuid',
      12345,
      ['x'],
      await invite(other), // valid, but for a different address
      await invite(email, { createdAt: new Date(Date.now() - 15 * 24 * 3600_000) }), // expired (14-day TTL)
      await invite(email, { status: 'revoked' }),
      await invite(email, { status: 'accepted' }),
      orphaned,
    ];
    expect(owner.user.id).toBeTruthy();
    for (const inviteToken of tokens) {
      const res = await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken });
      expect(res.status, JSON.stringify(inviteToken)).toBe(403);
      expect(res.body).toEqual(INVITE_ONLY);
    }
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('a valid invitation lets exactly its address sign up (any letter case); the invitation is then accepted and cannot create a second account', async () => {
    const { workspaceId, owner } = await inviter();
    const email = uniqueEmail();
    // Issued through the real API, exactly as the Invitations panel does.
    const issued = await request(app).post(`/api/workspaces/${workspaceId}/invites`).set(authHeader(owner.token)).send({ email });
    expect(issued.status).toBe(201);
    const inviteToken = issued.body.token as string;

    const res = await signup({ username: uniqueUsername(), email: email.toUpperCase(), password: PASSWORD, inviteToken });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    const accepted = await request(app).post(`/api/invitations/accept/${inviteToken}`).set(authHeader(res.body.token));
    expect(accepted.status).toBe(200);
    expect(accepted.body.workspaceId).toBe(workspaceId);
    expect(await prisma.workspaceMember.count({ where: { userId: res.body.user.id, workspaceId } })).toBe(1);

    // The invitation is used: it no longer opens sign-up for anyone.
    expect((await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken })).status).toBe(403);
    expect((await signup({ username: uniqueUsername(), email: uniqueEmail(), password: PASSWORD, inviteToken })).status).toBe(403);
  });

  it('gates the OTP sign-up path the same way, which still works with an invitation', async () => {
    const { invite } = await inviter();
    const email = uniqueEmail();
    const inviteToken = await invite(email);
    const username = uniqueUsername();
    expect((await signup({ username, email, password: PASSWORD, inviteToken }, '/api/auth/signup-request')).status).toBe(200);
    const code = vi.mocked(sendOtpEmail).mock.calls[0][1];
    expect((await signup({ email, code }, '/api/auth/verify-otp')).status).toBe(403); // the second step needs it too
    const verified = await signup({ email, code, inviteToken }, '/api/auth/verify-otp');
    expect(verified.status).toBe(201);
    expect(verified.body.user).toMatchObject({ username, email });
  });

  it('leaves invalid input to the unchanged validation (FA-SEC-02): it is rejected and never becomes an account', async () => {
    const res = await signup({ username: uniqueUsername(), email: 'not-an-email', password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid email format' });
    expect((await signup({ username: '', email: '', password: '' })).body).toEqual({ error: 'username, email and password are required' });
    expect(await prisma.user.count({ where: { email: 'not-an-email' } })).toBe(0);
  });

  it('leaves login, the Company Admin and admin Create User unchanged', async () => {
    const existing = await createAndLoginUser();
    expect((await request(app).post('/api/auth/login').send({ email: existing.user.email, password: PASSWORD })).status).toBe(200);
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const t = randomUUID().slice(0, 8);
    const created = await request(app).post('/api/admin/users').set(authHeader(admin.token)).send({ username: `inv_${t}`, loginId: `inv_${t}@example.com`, password: `pass-${t}` });
    expect(created.status).toBe(201);
    expect((await request(app).post('/api/auth/login').send({ email: `inv_${t}@example.com`, password: `pass-${t}` })).status).toBe(200);
  });

  it('rate-limits refused sign-up attempts per client', async () => {
    process.env.NODE_ENV = 'development';
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await signup({ username: uniqueUsername(), email: uniqueEmail(), password: PASSWORD })).status);
    expect(statuses.slice(0, 20).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});
