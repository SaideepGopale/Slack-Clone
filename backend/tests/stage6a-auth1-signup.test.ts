import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { ensureSharedWorkspace } from '../lib/sharedWorkspace';
import { createWorkspace } from './collab-helpers';
import { authHeader, createTeamLead, uniqueEmail, uniqueUsername } from './helpers';

vi.mock('../utils/mailer', () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPasswordEmail: vi.fn().mockResolvedValue(undefined),
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));
import { sendOtpEmail } from '../utils/mailer';

/**
 * Stage 6A (T.25) — AUTH-1: one sign-up invitation must open at most one
 * account. The invitation-only gate (T.21) matches the invited address in any
 * letter case, so every sign-up path must also treat "Alice@X.com" and
 * "alice@x.com" as the same, existing account — including when several
 * requests race with one invitation. Disposable test database only.
 */
const PASSWORD = 'Password123!';
const INVITE_ONLY = 'Sign-up is by invitation only. Open the invitation link you received to create your account.';
const post = (path: string, body: Record<string, unknown>) => request(app).post(path).send(body);
const signup = (body: Record<string, unknown>) => post('/api/auth/signup', body);

/** Accounts holding this address in any letter case, compared the way PostgreSQL compares it. */
const accountsFor = async (email: string) => {
  const [row] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "User" WHERE lower(email) = lower(${email}::text)`;
  return Number(row.n);
};
const invitationStatus = async (token: string) => (await prisma.invitation.findUniqueOrThrow({ where: { token } })).status;

/** A Team Lead's workspace whose owner issues real pending e-mail invitations. */
const inviter = async () => {
  const owner = await createTeamLead();
  const { workspaceId } = await createWorkspace(owner);
  const invite = async (email: string, extra: Record<string, unknown> = {}) =>
    (await prisma.invitation.create({ data: { email, inviterId: owner.user.id, workspaceId, ...extra } })).token;
  return { owner, workspaceId, invite };
};

/** "test-<uuid>@example.com" → "Test-<UUID>@example.com" etc.: same mailbox, other letter case. */
const variants = (email: string) => {
  const [local, domain] = email.split('@');
  return [email.toUpperCase(), `${local}@${domain.toUpperCase()}`, `${local[0].toUpperCase()}${local.slice(1)}@${domain}`];
};

// Sign-up joins SmartConnect Collab inside the account-creation transaction.
let collabId = '';
beforeAll(async () => {
  collabId = (await ensureSharedWorkspace()).workspaceId;
});
beforeEach(() => vi.mocked(sendOtpEmail).mockClear());

describe('Stage 6A — AUTH-1: one invitation, at most one account', () => {
  it('1. a valid invitation creates exactly one ACTIVE account, stored as typed (login unchanged)', async () => {
    const { invite } = await inviter();
    const email = uniqueEmail();
    const inviteToken = await invite(email);
    const typed = variants(email)[2]; // the invitee types their address with a capital letter
    const res = await signup({ username: uniqueUsername(), email: typed, password: PASSWORD, inviteToken });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(typed);
    const account = await prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    expect(account.status).toBe('ACTIVE');
    expect(await accountsFor(email)).toBe(1);
    expect((await post('/api/auth/login', { email: typed, password: PASSWORD })).status).toBe(200);
    // Sign-up alone does not join the invited workspace; acceptance (unchanged flow) does.
    expect(await invitationStatus(inviteToken)).toBe('pending');
  });

  it('2. letter-case variants of the invited address cannot open a second account', async () => {
    const { invite } = await inviter();
    const email = uniqueEmail();
    const inviteToken = await invite(email);
    expect((await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken })).status).toBe(201);
    for (const variant of variants(email)) {
      const res = await signup({ username: uniqueUsername(), email: variant, password: PASSWORD, inviteToken });
      expect(res.status, variant).toBe(400);
      expect(res.body.error, variant).toMatch(/already exists/);
    }
    expect(await accountsFor(email)).toBe(1);
  });

  it('3. an existing account in another letter case blocks every sign-up path', async () => {
    const { invite } = await inviter();
    const email = uniqueEmail();
    await prisma.user.create({ data: { email: email.toUpperCase(), username: uniqueUsername(), password: await bcrypt.hash(PASSWORD, 4) } });
    const inviteToken = await invite(email);

    const direct = await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken });
    expect(direct.status).toBe(400);
    expect(direct.body.error).toMatch(/already exists/);
    const otp = await post('/api/auth/signup-request', { username: uniqueUsername(), email, password: PASSWORD, inviteToken });
    expect(otp.status).toBe(400);
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(await accountsFor(email)).toBe(1);
  });

  it('4. a consumed invitation is refused: after its account exists (400) and after acceptance (403)', async () => {
    const { invite, workspaceId } = await inviter();
    const email = uniqueEmail();
    const inviteToken = await invite(email);
    const first = await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken });
    expect(first.status).toBe(201);
    expect((await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken })).status).toBe(400);

    const accepted = await request(app).post(`/api/invitations/accept/${inviteToken}`).set(authHeader(first.body.token));
    expect(accepted.status).toBe(200);
    expect(accepted.body.workspaceId).toBe(workspaceId);
    expect(await invitationStatus(inviteToken)).toBe('accepted');
    for (const address of [email, ...variants(email)]) {
      const res = await signup({ username: uniqueUsername(), email: address, password: PASSWORD, inviteToken });
      expect(res.status, address).toBe(403);
      expect(res.body.error).toBe(INVITE_ONLY);
    }
    expect(await accountsFor(email)).toBe(1);
  });

  it('5–7. expired, revoked and mismatched invitations are refused and create nothing', async () => {
    const { invite } = await inviter();
    const email = uniqueEmail();
    const refused = {
      expired: await invite(email, { createdAt: new Date(Date.now() - 15 * 24 * 3600_000) }),
      revoked: await invite(email, { status: 'revoked' }),
      mismatched: await invite(uniqueEmail()),
    };
    for (const [why, inviteToken] of Object.entries(refused)) {
      for (const path of ['/api/auth/signup', '/api/auth/signup-request']) {
        const res = await post(path, { username: uniqueUsername(), email, password: PASSWORD, inviteToken });
        expect(res.status, `${why} ${path}`).toBe(403);
        expect(res.body.error).toBe(INVITE_ONLY);
      }
    }
    expect(await accountsFor(email)).toBe(0);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('8. concurrent sign-ups with one invitation (direct and OTP paths, exact and case variants) create exactly one account', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { invite } = await inviter();
      const email = uniqueEmail();
      const inviteToken = await invite(email);
      // A pending OTP sign-up for one variant, completed in the same burst.
      const otpEmail = variants(email)[0];
      expect((await post('/api/auth/signup-request', { username: uniqueUsername(), email: otpEmail, password: PASSWORD, inviteToken })).status).toBe(200);
      const code = vi.mocked(sendOtpEmail).mock.calls.at(-1)![1];

      const burst = await Promise.all([
        ...[email, email, ...variants(email)].map((address) => signup({ username: uniqueUsername(), email: address, password: PASSWORD, inviteToken })),
        post('/api/auth/verify-otp', { email: otpEmail, code, inviteToken }),
      ]);
      const statuses = burst.map((r) => r.status).sort();
      expect(statuses, `round ${round}`).toEqual([201, 400, 400, 400, 400, 400]);
      for (const res of burst.filter((r) => r.status === 400)) expect(res.body.error).toMatch(/already exists/);
      expect(await accountsFor(email)).toBe(1);
    }
  });

  it('9. a failure while creating the account rolls everything back and leaves the invitation usable', async () => {
    const { invite } = await inviter();
    const email = uniqueEmail();
    const inviteToken = await invite(email);
    const marker = `s6afail_${randomUUID().slice(0, 8)}`;
    // Test database only: fail the transaction AFTER the User row is inserted
    // (when the new account joins SmartConnect Collab), proving the rollback.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION s6a_fail_signup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "User" WHERE id = NEW."userId" AND username = '${marker}') THEN
          RAISE EXCEPTION 'simulated failure during account creation';
        END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER s6a_fail_signup BEFORE INSERT ON "WorkspaceMember" FOR EACH ROW EXECUTE FUNCTION s6a_fail_signup()');
    try {
      const failed = await signup({ username: marker, email, password: PASSWORD, inviteToken });
      expect(failed.status).toBe(500);
      expect(await accountsFor(email)).toBe(0);
      expect(await prisma.user.count({ where: { username: marker } })).toBe(0);
      expect(await invitationStatus(inviteToken)).toBe('pending');

      const retry = await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken });
      expect(retry.status).toBe(201);
      expect(await accountsFor(email)).toBe(1);
      expect(await prisma.workspaceMember.count({ where: { userId: retry.body.user.id, workspaceId: collabId } })).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS s6a_fail_signup ON "WorkspaceMember"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS s6a_fail_signup()');
    }
  });

  it('10. the workspace invitation flow is unchanged: sign-up (OTP path, other case) then accept joins the invited workspace', async () => {
    const { invite, workspaceId } = await inviter();
    const email = uniqueEmail();
    const inviteToken = await invite(email);
    const typed = variants(email)[1];
    const username = uniqueUsername();
    expect((await post('/api/auth/signup-request', { username, email: typed, password: PASSWORD, inviteToken })).status).toBe(200);
    const code = vi.mocked(sendOtpEmail).mock.calls[0][1];
    const verified = await post('/api/auth/verify-otp', { email: typed, code, inviteToken });
    expect(verified.status).toBe(201);
    expect(verified.body.user).toMatchObject({ username, email: typed });
    const accepted = await request(app).post(`/api/invitations/accept/${inviteToken}`).set(authHeader(verified.body.token));
    expect(accepted.status).toBe(200);
    expect(await prisma.workspaceMember.count({ where: { userId: verified.body.user.id, workspaceId } })).toBe(1);
  });

  it('11. the gate and the account check use one comparison: an address PostgreSQL does not fold to the invited one is refused', async () => {
    const { invite } = await inviter();
    // JavaScript lower-cases a word-final "Σ" to "ς"; PostgreSQL's lower() gives "σ".
    const local = `sigma${randomUUID().slice(0, 8)}a`;
    const invited = `${local}ς@example.com`;
    const inviteToken = await invite(invited);
    const first = await signup({ username: uniqueUsername(), email: invited, password: PASSWORD, inviteToken });
    expect(first.status).toBe(201);
    const capital = `${local}Σ@example.com`;
    expect(capital.toLowerCase()).toBe(invited); // the gate's JavaScript check alone would accept it
    const second = await signup({ username: uniqueUsername(), email: capital, password: PASSWORD, inviteToken });
    expect(second.status).not.toBe(201);
    expect(await prisma.user.count({ where: { email: { startsWith: local } } })).toBe(1);
  });
});
