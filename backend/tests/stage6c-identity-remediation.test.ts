import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { ensureSharedWorkspace } from '../lib/sharedWorkspace';
import { lockSignupEmail } from '../lib/signupEmail';
import { createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, createTeamLead, uniqueEmail, uniqueUsername } from './helpers';

vi.mock('../utils/mailer', () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPasswordEmail: vi.fn().mockResolvedValue(undefined),
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));
import { sendOtpEmail } from '../utils/mailer';

/**
 * Stage 6C (entireanalysis.md T.27) — identity-integrity remediation.
 *  - IDN-3: every identity comparison is exact and case-insensitive; "_", "%"
 *    and "\" are ordinary characters (Prisma's `equals` + `mode:'insensitive'`
 *    compiled to an unescaped ILIKE, where they were wildcards / an escape).
 *  - R1: sign-up re-checks, inside its account-creation transaction, that a
 *    live invitation for the address still exists (FOR SHARE), so a revocation
 *    that commits first prevents the account, and one that comes later waits.
 * Plus regressions for login, admin "Create user", Team Lead / Member
 * provisioning, activation and the e-mail invitation flow. Disposable test
 * database only; races are made deterministic with test-database-only
 * triggers and locks that are always removed in `finally`.
 */
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'member-Permanent-pass-1';
const INVITE_ONLY = 'Sign-up is by invitation only. Open the invitation link you received to create your account.';
const HOLD_SECONDS = 3;

const tag = () => randomUUID().replace(/-/g, '').slice(0, 12);
const upper = (email: string) => email.toUpperCase();
const capitalised = (email: string) => `${email[0].toUpperCase()}${email.slice(1)}`;
const as = (u: { token: string }) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(u.token)).send(body),
  del: (path: string) => request(app).delete(path).set(authHeader(u.token)),
});
const post = (path: string, body: Record<string, unknown>) => request(app).post(path).send(body);
const signup = (body: Record<string, unknown>) => post('/api/auth/signup', body);
const login = (email: string, password: string) => post('/api/auth/login', { email, password });
const activate = (body: Record<string, unknown>) => post('/api/account-activation', body);
const tokenFrom = (url: string) => new URL(url).hash.replace(/^#token=/, '');

const accountsFor = async (email: string) => {
  const [row] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "User" WHERE lower(email) = lower(${email}::text)`;
  return Number(row.n);
};
const invitationStatus = async (id: string) => (await prisma.invitation.findUniqueOrThrow({ where: { id } })).status;
/** An ACTIVE account created directly (what an older account looks like). */
const existingUser = (email: string) => prisma.user.create({ data: { email, username: uniqueUsername(), password: 'not-a-login' }, select: { id: true, email: true } });

let admin: TestUser;
let lead: TestUser;
let workspaceId = '';
beforeAll(async () => {
  await ensureSharedWorkspace();
  admin = await createAndLoginUser({ role: 'ADMIN' });
  lead = await createTeamLead();
  ({ workspaceId } = await createWorkspace(lead));
});
beforeEach(() => vi.mocked(sendOtpEmail).mockClear());

const invite = (email: string) =>
  prisma.invitation.create({ data: { email: email.trim().toLowerCase(), inviterId: lead.user.id, workspaceId }, select: { id: true, token: true } });
const revoke = (invitationId: string) => as(lead).del(`/api/workspaces/${workspaceId}/invitations/${invitationId}`);
const signupWithInvite = async (email: string, username = uniqueUsername()) =>
  signup({ username, email, password: PASSWORD, inviteToken: (await invite(email)).token });
const adminCreate = (loginId: string, username = uniqueUsername(), extra: Record<string, unknown> = {}) =>
  as(admin).post('/api/admin/users', { username, loginId, password: PASSWORD, ...extra });
const provisionTeamLead = (email: string, displayName?: string) =>
  as(admin).post('/api/team-management/team-leads', { email, ...(displayName ? { displayName } : {}) });
const provisionMember = (email: string) => as(lead).post(`/api/workspaces/${workspaceId}/member-invitations`, { email });

const waitFor = async (probe: () => Promise<boolean> | boolean, what: string, ms = 10_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const countOf = async (query: Prisma.Sql) => Number((await prisma.$queryRaw<{ n: bigint }[]>(query))[0].n);
const insertIsHeld = async () => (await countOf(Prisma.sql`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'`)) > 0;
const waitsOnAdvisoryLock = async () => (await countOf(Prisma.sql`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)) > 0;
const waitsOnRowLock = async () =>
  (await countOf(Prisma.sql`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')`)) > 0;

/** A test-database-only BEFORE INSERT trigger on "User" for one exact address: `body` is PL/pgSQL. */
const withUserInsertTrigger = async <T>(address: string, body: string, run: () => Promise<T>) => {
  if (!/^[A-Za-z0-9.@+-]+$/.test(address)) throw new Error('unexpected characters in a test address');
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION s6c_user_insert() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN IF NEW.email = '${address}' THEN ${body} END IF; RETURN NEW; END $f$`
  );
  await prisma.$executeRawUnsafe('CREATE TRIGGER s6c_user_insert BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION s6c_user_insert()');
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS s6c_user_insert ON "User"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS s6c_user_insert()');
  }
};

/** Holds the per-address sign-up lock so a sign-up stops inside its transaction, after the gate; returns its release. */
const holdSignupLock = async (email: string) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let holding = false;
  const holder = prisma.$transaction(
    async (tx) => {
      await lockSignupEmail(tx, email);
      holding = true;
      await released;
    },
    { timeout: 30_000, maxWait: 5_000 }
  );
  await waitFor(() => holding, 'the lock holder');
  return async () => {
    release();
    await holder;
  };
};

describe('Stage 6C — IDN-3: "_", "%" and "\\" are ordinary characters in identity comparisons', () => {
  it('#1 "_": look-alike addresses are different people on every path, and nobody else\'s details come back', async () => {
    const t = tag();
    const existing = await existingUser(`u-${t}@example.com`);
    await prisma.workspaceMember.create({ data: { userId: existing.id, workspaceId, role: 'MEMBER' } });

    const member = await provisionMember(`u_${t}@example.com`);
    expect(member.status).toBe(201);
    expect(JSON.stringify(member.body)).not.toContain(existing.id);
    expect((await provisionTeamLead(`u-${t.slice(0, 11)}_@example.com`)).status).toBe(201);
    expect((await adminCreate(`_-${t}@example.com`)).status).toBe(201);

    // E-mail invitation: not "already a member", and the token page doesn't claim an account exists.
    const created = await as(lead).post('/api/invitations', { email: `u-${t}@exampl_.com`, workspaceId });
    expect(created.status).toBe(201);
    const page = await request(app).get(`/api/invitations/${created.body.token}`);
    expect(page.status).toBe(200);
    expect(page.body.isExistingUser).toBe(false);
    expect(await accountsFor(existing.email)).toBe(1);
  });

  it('#2 "%": no pattern matching in provisioning, invitations or the exact-login member search', async () => {
    const t = tag();
    const existing = await existingUser(`p-${t}@example.com`); // ACTIVE, not in the lead's workspace
    const pattern = `p-${t.slice(0, 6)}%@example.com`;

    const member = await provisionMember(pattern);
    expect(member.status).toBe(201);
    expect(JSON.stringify(member.body)).not.toContain(existing.id);
    expect((await provisionTeamLead(`p-%${t.slice(6)}@example.com`)).status).toBe(201);
    expect((await adminCreate(`p-${t}@%.com`)).status).toBe(201);

    const search = (q: string) => as(lead).get(`/api/workspaces/${workspaceId}/member-candidates?q=${encodeURIComponent(q)}`);
    const byPattern = await search(`p-${t.slice(0, 6)}%`);
    expect(byPattern.status).toBe(200);
    expect(byPattern.body.users.map((u: { id: string }) => u.id)).not.toContain(existing.id);
    // The exact login, in any letter case, still finds the account (FA-SEC-03 semantics).
    expect((await search(upper(existing.email))).body.users.map((u: { id: string }) => u.id)).toContain(existing.id);
    expect(await accountsFor(existing.email)).toBe(1);
  });

  it('#3 "\\": not an escape character — a different address stays different, the same address in another case is the same', async () => {
    const t = tag();
    const plain = await existingUser(`b-${t}q@example.com`);
    const different = await provisionMember(`b-${t}\\q@example.com`);
    expect(different.status).toBe(201);
    expect(JSON.stringify(different.body)).not.toContain(plain.id);

    const typed = `B-${upper(t)}\\X@EXAMPLE.COM`;
    const created = await adminCreate(typed);
    expect(created.status).toBe(201);
    expect((await adminCreate(typed.toLowerCase())).status).toBe(409); // IDN-2: no twin, even without the index
    expect((await provisionTeamLead(typed.toLowerCase())).status).toBe(409);
    const offered = await provisionMember(typed.toLowerCase());
    expect(offered.status).toBe(409);
    expect(offered.body).toMatchObject({ existingAccount: true, user: { id: created.body.id } });
    expect((await signupWithInvite(typed.toLowerCase())).status).toBe(400);
    expect(await accountsFor(typed)).toBe(1);
  });

  it('#4 exact equality across paths: an address with "_", "%" and "\\" is one identity whichever path created it', async () => {
    const t = tag();
    const tricky = (prefix: string) => `${prefix}_${t}%x\\y@Example.com`;

    const bySignup = tricky('s');
    expect((await signupWithInvite(bySignup)).status).toBe(201);
    expect((await adminCreate(upper(bySignup))).status).toBe(409);
    expect((await provisionTeamLead(upper(bySignup))).status).toBe(409);
    expect((await provisionMember(bySignup.toLowerCase())).body.existingAccount).toBe(true);

    const byAdmin = tricky('a');
    expect((await adminCreate(byAdmin)).status).toBe(201);
    expect((await signupWithInvite(byAdmin.toLowerCase())).status).toBe(400);
    expect((await provisionTeamLead(byAdmin)).status).toBe(409);
    expect((await provisionMember(upper(byAdmin))).status).toBe(409);

    const byLead = tricky('m');
    expect((await provisionMember(byLead)).status).toBe(201);
    expect((await adminCreate(byLead)).status).toBe(409);
    expect((await signupWithInvite(upper(byLead))).status).toBe(400);
    expect((await provisionTeamLead(upper(byLead))).status).toBe(409);

    for (const address of [bySignup, byAdmin, byLead]) expect(await accountsFor(address)).toBe(1);
  });
});

describe('Stage 6C — R1: invitation revocation and sign-up', () => {
  it('#5 sign-up after the revocation has committed is refused with the gate\'s answer', async () => {
    const email = uniqueEmail();
    const invitation = await invite(email);
    expect((await revoke(invitation.id)).status).toBe(200);
    const res = await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken: invitation.token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(INVITE_ONLY);
    expect(await accountsFor(email)).toBe(0);
  });

  it('#5b verify-otp: a revocation committed while the code is being verified prevents the account', async () => {
    const email = uniqueEmail();
    const invitation = await invite(email);
    const requested = await post('/api/auth/signup-request', { username: uniqueUsername(), email, password: PASSWORD, inviteToken: invitation.token });
    expect(requested.status).toBe(200);
    const code = vi.mocked(sendOtpEmail).mock.calls.at(-1)![1] as string;

    const release = await holdSignupLock(email);
    const verified = (async () => await post('/api/auth/verify-otp', { email, code, inviteToken: invitation.token }))();
    try {
      await waitFor(waitsOnAdvisoryLock, 'verify-otp to wait on the per-address lock');
      expect((await revoke(invitation.id)).status).toBe(200);
    } finally {
      await release();
    }
    const res = await verified;
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(INVITE_ONLY);
    expect(await accountsFor(email)).toBe(0);
  }, 30_000);

  it('#6 a revocation racing a sign-up that already holds the invitation waits for it: one account, then revoked', async () => {
    const email = uniqueEmail();
    const typed = capitalised(email);
    const invitation = await invite(email);
    const { signedUp, revoked } = await withUserInsertTrigger(typed, `PERFORM pg_sleep(${HOLD_SECONDS});`, async () => {
      const signedUpP = (async () => await signup({ username: uniqueUsername(), email: typed, password: PASSWORD, inviteToken: invitation.token }))();
      await waitFor(insertIsHeld, 'the sign-up INSERT to be held');
      const revokedP = (async () => await revoke(invitation.id))();
      // The revocation's UPDATE must wait for the sign-up's FOR SHARE on the invitation row.
      await waitFor(waitsOnRowLock, 'the revocation to wait on the invitation row');
      return { signedUp: await signedUpP, revoked: await revokedP };
    });
    expect(signedUp.status).toBe(201);
    expect(revoked.status).toBe(200);
    expect(await accountsFor(email)).toBe(1);
    expect(await invitationStatus(invitation.id)).toBe('revoked');
    // The existing accept flow then refuses the revoked invitation; the account keeps SmartConnect Collab only.
    const accepted = await request(app).post(`/api/invitations/accept/${invitation.token}`).set(authHeader(signedUp.body.token));
    expect(accepted.status).toBe(400);
    expect(await prisma.workspaceMember.count({ where: { userId: signedUp.body.user.id, workspaceId } })).toBe(0);
  }, 30_000);

  it('#7 a failed sign-up leaves its invitation pending and usable — refused before, or failing inside, the transaction', async () => {
    const email = uniqueEmail();
    const invitation = await invite(email);
    const taken = await createAndLoginUser();
    expect((await signup({ username: taken.user.username, email, password: PASSWORD, inviteToken: invitation.token })).status).toBe(400);
    expect(await invitationStatus(invitation.id)).toBe('pending');

    const failed = await withUserInsertTrigger(email, `RAISE EXCEPTION 's6c: simulated failure while creating the account';`, () =>
      signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken: invitation.token })
    );
    expect(failed.status).toBe(500);
    expect(await accountsFor(email)).toBe(0);
    expect(await invitationStatus(invitation.id)).toBe('pending');

    const retried = await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken: invitation.token });
    expect(retried.status).toBe(201);
    expect(await invitationStatus(invitation.id)).toBe('pending'); // sign-up never consumes; acceptance does
    expect((await request(app).post(`/api/invitations/accept/${invitation.token}`).set(authHeader(retried.body.token))).status).toBe(200);
    expect(await invitationStatus(invitation.id)).toBe('accepted');
  });

  it('#8 concurrent sign-ups on one invitation: exactly one account, invitation left pending', async () => {
    const email = uniqueEmail();
    const invitation = await invite(email);
    const forms = [email, email, upper(email), capitalised(email), email.replace('@example.com', '@EXAMPLE.COM')];
    const results = await Promise.all(forms.map((form) => signup({ username: uniqueUsername(), email: form, password: PASSWORD, inviteToken: invitation.token })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400, 400, 400]);
    expect(await accountsFor(email)).toBe(1);
    expect(await invitationStatus(invitation.id)).toBe('pending');
  });

  it('#8b concurrent sign-ups and a revocation on one invitation: at most one account, and only if it won', async () => {
    const email = uniqueEmail();
    const invitation = await invite(email);
    const forms = [email, upper(email), capitalised(email)];
    const [revoked, ...signups] = await Promise.all([
      revoke(invitation.id),
      ...forms.map((form) => signup({ username: uniqueUsername(), email: form, password: PASSWORD, inviteToken: invitation.token })),
    ]);
    const statuses = signups.map((r) => r.status);
    const created = statuses.filter((s) => s === 201).length;
    expect(revoked.status).toBe(200);
    expect(created).toBeLessThanOrEqual(1);
    expect(statuses.every((s) => [201, 400, 403].includes(s))).toBe(true);
    expect(await accountsFor(email)).toBe(created);
    expect(await invitationStatus(invitation.id)).toBe('revoked');
  });
});

describe('Stage 6C — regressions', () => {
  it('#9 activation of a provisioned Member, and sign-up + acceptance of an e-mail invitation, still work', async () => {
    const provisioned = await provisionMember(uniqueEmail());
    expect(provisioned.status).toBe(201);
    const { credentials, invitation: accountInvitation } = provisioned.body;
    const activated = await activate({ token: tokenFrom(credentials.activationUrl), temporaryPassword: credentials.temporaryPassword, newPassword: NEW_PASSWORD });
    expect(activated.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: accountInvitation.account.id } })).status).toBe('ACTIVE');
    expect(await prisma.workspaceMember.count({ where: { userId: accountInvitation.account.id, workspaceId } })).toBe(1);
    expect((await login(credentials.loginId, NEW_PASSWORD)).status).toBe(200);

    const email = uniqueEmail();
    const invitation = await invite(email);
    const signedUp = await signup({ username: uniqueUsername(), email: upper(email), password: PASSWORD, inviteToken: invitation.token });
    expect(signedUp.status).toBe(201);
    expect((await request(app).post(`/api/invitations/accept/${invitation.token}`).set(authHeader(signedUp.body.token))).status).toBe(200);
    expect(await invitationStatus(invitation.id)).toBe('accepted');
    expect(await prisma.workspaceMember.count({ where: { userId: signedUp.body.user.id, workspaceId } })).toBe(1);
    // A used invitation no longer opens sign-up.
    expect((await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken: invitation.token })).status).toBe(403);
  });

  it('#10 login still matches the stored address exactly, including "_", "%" and "\\"', async () => {
    const t = tag();
    const loginId = `L_${t}%Q\\R@Example.com`;
    expect((await adminCreate(loginId)).status).toBe(201);
    expect((await login(loginId, PASSWORD)).status).toBe(200);
    expect((await login(loginId.toLowerCase(), PASSWORD)).status).toBe(401);
    expect((await login(upper(loginId), PASSWORD)).status).toBe(401);
    expect((await login(`L_${t}%Q\\R@Example.co_`, PASSWORD)).status).toBe(401);
  });

  it('#11 admin "Create user": stored as typed, ACTIVE joins Collab, conflict messages unchanged, "_" in usernames is literal', async () => {
    const t = tag();
    const first = await adminCreate(`Ad-${t}@x`, `ad-${t}`);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ loginId: `Ad-${t}@x`, username: `ad-${t}`, role: 'USER', status: 'ACTIVE' });
    expect(await prisma.workspaceMember.count({ where: { userId: first.body.id, workspace: { isDefault: true } } })).toBe(1);

    const sameUsername = await adminCreate(`other-${t}@x`, `AD-${t}`);
    expect(sameUsername.status).toBe(409);
    expect(sameUsername.body.error).toBe('That username is already taken.');
    const sameLogin = await adminCreate(`AD-${t}@X`, `fresh-${t}`);
    expect(sameLogin.status).toBe(409);
    expect(sameLogin.body.error).toBe('An account with that login already exists.');

    expect((await adminCreate(`w-${t}@x`, `ad_${t}`)).status).toBe(201); // "_" is not a wildcard for "-"
    const suspended = await adminCreate(`su-${t}@x`, `su-${t}`, { status: 'SUSPENDED' });
    expect(suspended.status).toBe(201);
    expect(suspended.body.status).toBe('SUSPENDED');
  });

  it('#12 Team Lead and Member provisioning: same semantics; generated usernames treat "_" literally', async () => {
    const t = tag();
    await prisma.user.create({ data: { email: `holder-${t}@example.com`, username: `uq-${t}`, password: 'not-a-login' } });
    const email = `TL-${t}@Example.com`;
    const created = await provisionTeamLead(email, `uq_${t}`);
    expect(created.status).toBe(201);
    expect(created.body.teamLead).toMatchObject({ username: `uq_${t}`, loginId: email.toLowerCase(), status: 'SUSPENDED', invitation: { status: 'PENDING' } });

    const again = await provisionTeamLead(upper(email));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('An account with this e-mail address already exists.');
    expect((await provisionTeamLead('System@SmartConnect.internal')).status).toBe(409);

    const pending = await provisionMember(capitalised(email.toLowerCase()));
    expect(pending.status).toBe(409);
    expect(pending.body.pendingActivation).toBe(true);
    const colleague = await createAndLoginUser();
    await prisma.workspaceMember.create({ data: { userId: colleague.user.id, workspaceId, role: 'MEMBER' } });
    const already = await provisionMember(upper(colleague.user.email));
    expect(already.status).toBe(409);
    expect(already.body.alreadyMember).toBe(true);
  });
});
