import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, createTeamLead } from './helpers';

/**
 * T.36 — adding team members locally without SMTP.
 *
 * The no-e-mail path already exists (Stage 3): a Team Lead creates a Member
 * account with a one-time activation link and temporary password, or adds an
 * existing account directly. What was wrong: with no e-mail provider
 * configured (RESEND_API_KEY unset), an e-mail invitation still answered
 * "Invite sent successfully" — the mailer returned { success: false } instead
 * of throwing, and the result was ignored.
 */

// The real mailer, with sendInviteEmail observable so tests can assert it was
// (or was not) asked to send anything.
vi.mock('../utils/mailer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/mailer')>();
  return { ...real, sendInviteEmail: vi.fn(real.sendInviteEmail) };
});
const mailer = await import('../utils/mailer');

const as = (u: TestUser) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(u.token)).send(body),
});
const tag = () => randomUUID().slice(0, 8);
const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY; // no e-mail provider, as on the local dev setup
  vi.mocked(mailer.sendInviteEmail).mockClear();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedKey;
});

describe('T.36 — e-mail invitations never claim to be sent without e-mail delivery', () => {
  it('no e-mail provider: the invitation is saved, the answer says no e-mail was sent, and nothing tries to send one', async () => {
    const lead = await createTeamLead();
    const { workspaceId } = await createWorkspace(lead);
    const email = `invitee-${tag()}@example.com`;

    const res = await as(lead).post(`/api/workspaces/${workspaceId}/invites`, { email });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, emailSent: false, emailUnavailable: true });
    expect(res.body.message).toMatch(/no e-mail was sent/i);
    expect(res.body.message).not.toMatch(/sent successfully/i);
    expect(mailer.sendInviteEmail).not.toHaveBeenCalled();
    // Still a real pending invitation (it lets that address sign up).
    expect(await prisma.invitation.count({ where: { workspaceId, email, status: 'pending' } })).toBe(1);
  });

  it('with e-mail delivery configured and the e-mail accepted, it says sent', async () => {
    process.env.RESEND_API_KEY = 're_test_not_a_real_key';
    vi.mocked(mailer.sendInviteEmail).mockResolvedValueOnce({ success: true, messageId: 'm1' });
    const lead = await createTeamLead();
    const { workspaceId } = await createWorkspace(lead);

    const res = await as(lead).post(`/api/workspaces/${workspaceId}/invites`, { email: `invitee-${tag()}@example.com` });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, emailSent: true });
    expect(res.body.emailUnavailable).toBeUndefined();
    expect(mailer.sendInviteEmail).toHaveBeenCalledTimes(1);
  });

  it('workspace settings tell managers up front whether e-mail invitations are available', async () => {
    const lead = await createTeamLead();
    const { workspaceId } = await createWorkspace(lead);
    expect((await as(lead).get(`/api/workspaces/${workspaceId}/settings`)).body.emailInvitationsAvailable).toBe(false);
    process.env.RESEND_API_KEY = 're_test_not_a_real_key';
    expect((await as(lead).get(`/api/workspaces/${workspaceId}/settings`)).body.emailInvitationsAvailable).toBe(true);
  });
});

/**
 * The local workflow end to end through the API, with no e-mail provider:
 * every step of the requested checklist. (Regression coverage of the Stage 3
 * flow this builds on — these pass on the existing code.)
 */
describe('T.36 — a Team Lead adds members with no e-mail provider', () => {
  it('creates a Member who activates, signs in, sees exactly that workspace — and nothing in the request can raise their role', async () => {
    expect(process.env.RESEND_API_KEY).toBeUndefined();
    const lead = await createTeamLead();
    const { workspaceId } = await createWorkspace(lead, `Team ${tag()}`);
    const other = await createTeamLead();
    const { workspaceId: otherWorkspaceId } = await createWorkspace(other, `Other ${tag()}`);

    // Escalation fields are ignored: only e-mail and display name are read.
    const email = `new-member-${tag()}@example.com`;
    const created = await as(lead).post(`/api/workspaces/${workspaceId}/member-invitations`, {
      email,
      displayName: 'Mia Member',
      role: 'ADMIN',
      tier: 'TEAM_LEAD',
      status: 'ACTIVE',
      workspaceRole: 'ADMIN',
      password: 'chosen-by-the-request-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { temporaryPassword, activationUrl } = created.body.credentials;
    expect(typeof temporaryPassword).toBe('string');
    expect(activationUrl).toMatch(/\/activate#token=/);
    expect(mailer.sendInviteEmail).not.toHaveBeenCalled();

    // Stored hashed only; never the temporary password in clear.
    const account = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, role: true, status: true, password: true } });
    expect(account).toMatchObject({ role: 'USER', status: 'SUSPENDED' });
    const invitation = await prisma.accountInvitation.findFirstOrThrow({ where: { userId: account.id } });
    expect(invitation.tempPasswordHash).not.toBe(temporaryPassword);
    expect(JSON.stringify(invitation)).not.toContain(temporaryPassword);
    expect(await prisma.auditLog.count({ where: { details: { contains: temporaryPassword } } })).toBe(0);
    expect(await prisma.accountTierGrant.count({ where: { userId: account.id } })).toBe(0); // MEMBER
    // Neither the temporary password nor the requested one signs in before activation.
    expect((await login(email, temporaryPassword)).status).toBe(401);
    expect((await login(email, 'chosen-by-the-request-1')).status).toBe(401);

    // Activation: temporary password + the member's own new password.
    const token = new URL(activationUrl).hash.replace(/^#token=/, '');
    const newPassword = 'member-Own-password-1';
    expect((await request(app).post('/api/account-activation').send({ token, temporaryPassword, newPassword })).status).toBe(200);
    expect((await login(email, temporaryPassword)).status).toBe(401);
    const signedIn = await login(email, newPassword);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user.role).toBe('USER');
    const member = { user: { id: account.id }, token: signedIn.body.token } as unknown as TestUser;

    // Sees exactly that workspace (plus the company-wide Collab), as a MEMBER.
    const list = await as(member).get('/api/workspaces');
    const mine = (list.body as { id: string; isDefault: boolean }[]).filter((w) => !w.isDefault).map((w) => w.id);
    expect(mine).toEqual([workspaceId]);
    expect(await prisma.workspaceMember.findUniqueOrThrow({ where: { userId_workspaceId: { userId: account.id, workspaceId } }, select: { role: true } })).toEqual({ role: 'MEMBER' });
    // …and cannot reach a workspace they were not added to.
    expect([403, 404]).toContain((await as(member).get(`/api/workspaces/${otherWorkspaceId}/channels`)).status);

    // A Member cannot add members, and cannot make themselves an admin.
    expect((await as(member).post(`/api/workspaces/${workspaceId}/member-invitations`, { email: `x-${tag()}@example.com` })).status).toBe(403);
    expect((await as(member).post(`/api/workspaces/${workspaceId}/members`, { userId: other.user.id })).status).toBe(403);
    expect([403, 404]).toContain((await request(app).patch(`/api/workspaces/${workspaceId}/members/${account.id}`).set(authHeader(member.token)).send({ role: 'ADMIN' })).status);
  });

  it('adds an existing account once (no duplicate account or membership); other leads, members and the Company Admin cannot add here', async () => {
    const lead = await createTeamLead();
    const { workspaceId } = await createWorkspace(lead, `Team ${tag()}`);
    const existing = await createAndLoginUser();

    // The same "Add member" call with an existing address: no second account, the existing one is offered.
    const offered = await as(lead).post(`/api/workspaces/${workspaceId}/member-invitations`, { email: existing.user.email.toUpperCase() });
    expect(offered.status).toBe(409);
    expect(offered.body).toMatchObject({ existingAccount: true, user: { id: existing.user.id } });
    expect(await prisma.user.count({ where: { email: { equals: existing.user.email, mode: 'insensitive' } } })).toBe(1);

    expect((await as(lead).post(`/api/workspaces/${workspaceId}/members`, { userId: existing.user.id })).status).toBe(201);
    const again = await as(lead).post(`/api/workspaces/${workspaceId}/members`, { userId: existing.user.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already a member/);
    expect(await prisma.workspaceMember.count({ where: { workspaceId, userId: existing.user.id } })).toBe(1);
    // Asking to create them again now says they are already a member.
    expect((await as(lead).post(`/api/workspaces/${workspaceId}/member-invitations`, { email: existing.user.email })).body).toMatchObject({ alreadyMember: true });

    // Unauthorized: another Team Lead, a plain user, and the Company Admin.
    const otherLead = await createTeamLead();
    const outsider = await createAndLoginUser();
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const target = await createAndLoginUser();
    for (const actor of [otherLead, outsider, admin]) {
      expect([403, 404]).toContain((await as(actor).post(`/api/workspaces/${workspaceId}/member-invitations`, { email: `y-${tag()}@example.com` })).status);
      expect([403, 404]).toContain((await as(actor).post(`/api/workspaces/${workspaceId}/members`, { userId: target.user.id })).status);
    }
    expect(await prisma.workspaceMember.count({ where: { workspaceId, userId: target.user.id } })).toBe(0);
    // Admin functionality itself is intact.
    expect((await as(admin).get('/api/admin/stats')).status).toBe(200);
  });
});
