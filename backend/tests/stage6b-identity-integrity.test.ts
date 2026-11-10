import { Prisma } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

/**
 * Stage 6B (entireanalysis.md T.26) — account identity integrity across every
 * account-creation path: public sign-up (invitation-only), admin "Create
 * user", Company Admin → Team Lead and Team Lead → Member provisioning, and
 * activation. Invariant: one e-mail address (PostgreSQL lower()) identifies at
 * most one account. Disposable test database only.
 *
 * Groups:
 *  - "current guarantees" always run;
 *  - "R2" are acceptance tests for the `User_email_lower_key` unique index
 *    (migration 20261111100000_user_email_case_insensitive_unique). They run
 *    whenever that index exists, or on demand with STAGE6B_RUN_PENDING=1
 *    (without the index they fail: the race evidence recorded in T.26);
 *  - "R1" and "IDN-3" were fixed in Stage 6C (T.27) and always run.
 *
 * The races are made deterministic with a BEFORE INSERT trigger, created on
 * the test database only and dropped in `finally`, that holds one request's
 * INSERT INTO "User" for a few seconds while the other request completes.
 */
const RUN_PENDING = process.env.STAGE6B_RUN_PENDING === '1';
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'member-Permanent-pass-1';
const HOLD_SECONDS = 3;

const as = (u: { token: string }) => ({
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(u.token)).send(body),
  del: (path: string) => request(app).delete(path).set(authHeader(u.token)),
});
const signup = (body: Record<string, unknown>) => request(app).post('/api/auth/signup').send(body);
const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });
const activate = (body: Record<string, unknown>) => request(app).post('/api/account-activation').send(body);
const tokenFrom = (url: string) => new URL(url).hash.replace(/^#token=/, '');

const upper = (email: string) => email.toUpperCase();
const capitalised = (email: string) => `${email[0].toUpperCase()}${email.slice(1)}`;

/** Accounts holding this address in any letter case, compared the way PostgreSQL compares it. */
const accountsFor = async (email: string) => {
  const [row] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "User" WHERE lower(email) = lower(${email}::text)`;
  return Number(row.n);
};

let admin: TestUser;
let lead: TestUser;
let workspaceId = '';
let runIndexTests = RUN_PENDING;

beforeAll(async () => {
  await ensureSharedWorkspace(); // sign-up and activation join SmartConnect Collab
  admin = await createAndLoginUser({ role: 'ADMIN' });
  lead = await createTeamLead();
  ({ workspaceId } = await createWorkspace(lead));
  const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_index i
    WHERE i.indrelid = '"User"'::regclass AND i.indisunique AND i.indisvalid
      AND pg_get_indexdef(i.indexrelid) LIKE '%(lower(email))%'`;
  runIndexTests ||= Number(row.n) > 0;
  console.info(`[stage6b] lower(email) unique index present: ${Number(row.n) > 0}; pending tests forced: ${RUN_PENDING}`);
});

/** A real pending workspace e-mail invitation from the lead (what the sign-up gate requires). */
const invite = async (email: string) =>
  prisma.invitation.create({ data: { email: email.trim().toLowerCase(), inviterId: lead.user.id, workspaceId }, select: { id: true, token: true } });
const signupWithInvite = async (email: string) => signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken: (await invite(email)).token });
const adminCreate = (loginId: string) => as(admin).post('/api/admin/users', { username: uniqueUsername(), loginId, password: PASSWORD });
const provisionTeamLead = (email: string) => as(admin).post('/api/team-management/team-leads', { email });
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
const insertIsHeld = () => countOf(Prisma.sql`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'`);
const waitsOnAdvisoryLock = () => countOf(Prisma.sql`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);

/**
 * Runs `held` (whose INSERT INTO "User" of exactly `heldAddress` is held for
 * HOLD_SECONDS inside the database, after its own duplicate check) and, while
 * it is held, runs `other` to completion. Returns both responses.
 */
const race = async (heldAddress: string, held: () => PromiseLike<request.Response>, other: () => PromiseLike<request.Response>) => {
  if (!/^[A-Za-z0-9.@+-]+$/.test(heldAddress)) throw new Error('unexpected characters in a test address');
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION s6b_hold_user_insert() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN IF NEW.email = '${heldAddress}' THEN PERFORM pg_sleep(${HOLD_SECONDS}); END IF; RETURN NEW; END $f$`
  );
  await prisma.$executeRawUnsafe('CREATE TRIGGER s6b_hold_user_insert BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION s6b_hold_user_insert()');
  try {
    const heldResponse = (async () => await held())();
    await waitFor(async () => (await insertIsHeld()) > 0, 'the held INSERT');
    const otherResponse = await other();
    return { held: await heldResponse, other: otherResponse };
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS s6b_hold_user_insert ON "User"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS s6b_hold_user_insert()');
  }
};

describe('Stage 6B — current guarantees (always run)', () => {
  it('A1 (#7) login still matches the stored address exactly, on every creation path', async () => {
    // Pins today's exact-match login (T.25 R4); change deliberately if login is ever made case-insensitive.
    const typed = capitalised(uniqueEmail()); // sign-up stores the address as typed
    expect((await signupWithInvite(typed)).status).toBe(201);
    expect((await login(typed, PASSWORD)).status).toBe(200);
    expect((await login(typed.toLowerCase(), PASSWORD)).status).toBe(401);

    const loginId = upper(uniqueEmail()); // admin "Create user" stores the login as typed
    expect((await adminCreate(loginId)).status).toBe(201);
    expect((await login(loginId, PASSWORD)).status).toBe(200);
    expect((await login(loginId.toLowerCase(), PASSWORD)).status).toBe(401);

    const asked = upper(uniqueEmail()); // Team Lead → Member provisioning stores lower case
    const provisioned = await provisionMember(asked);
    expect(provisioned.status).toBe(201);
    const { credentials } = provisioned.body;
    expect(credentials.loginId).toBe(asked.toLowerCase());
    const activated = await activate({ token: tokenFrom(credentials.activationUrl), temporaryPassword: credentials.temporaryPassword, newPassword: NEW_PASSWORD });
    expect(activated.status).toBe(200);
    expect((await login(credentials.loginId, NEW_PASSWORD)).status).toBe(200);
    expect((await login(asked, NEW_PASSWORD)).status).toBe(401);
  });

  it('A2 (#3, #8) every creation path refuses a letter-case variant of an existing address, whichever path created it', async () => {
    const bySignup = uniqueEmail();
    expect((await signupWithInvite(bySignup)).status).toBe(201);
    expect((await adminCreate(upper(bySignup))).status).toBe(409);
    expect((await provisionTeamLead(capitalised(bySignup))).status).toBe(409);
    const offered = await provisionMember(upper(bySignup));
    expect(offered.status).toBe(409);
    expect(offered.body.existingAccount).toBe(true);
    expect(await accountsFor(bySignup)).toBe(1);

    const byAdmin = uniqueEmail();
    expect((await adminCreate(upper(byAdmin))).status).toBe(201);
    expect((await signupWithInvite(byAdmin)).status).toBe(400);
    expect((await provisionTeamLead(byAdmin)).status).toBe(409);
    expect((await provisionMember(capitalised(byAdmin))).status).toBe(409);
    expect((await adminCreate(capitalised(byAdmin))).status).toBe(409);
    expect(await accountsFor(byAdmin)).toBe(1);

    const byLead = uniqueEmail();
    expect((await provisionMember(upper(byLead))).status).toBe(201);
    expect((await signupWithInvite(capitalised(byLead))).status).toBe(400);
    expect((await adminCreate(upper(byLead))).status).toBe(409);
    expect((await provisionTeamLead(upper(byLead))).status).toBe(409);
    const again = await provisionMember(capitalised(byLead));
    expect(again.status).toBe(409);
    expect(again.body.pendingActivation).toBe(true);
    expect(await accountsFor(byLead)).toBe(1);

    const byCompanyAdmin = uniqueEmail();
    expect((await provisionTeamLead(upper(byCompanyAdmin))).status).toBe(201);
    expect((await signupWithInvite(byCompanyAdmin)).status).toBe(400);
    expect((await adminCreate(capitalised(byCompanyAdmin))).status).toBe(409);
    expect((await provisionMember(byCompanyAdmin)).status).toBe(409);
    expect(await accountsFor(byCompanyAdmin)).toBe(1);
  });

  it('A3 (#4) activation racing a sign-up for the same address: the activation wins and no second account appears', async () => {
    const email = uniqueEmail();
    const provisioned = await provisionMember(email);
    expect(provisioned.status).toBe(201);
    const { credentials } = provisioned.body;
    const { token } = await invite(email); // the same person also holds an e-mail invitation
    const [activated, signedUp] = await Promise.all([
      activate({ token: tokenFrom(credentials.activationUrl), temporaryPassword: credentials.temporaryPassword, newPassword: NEW_PASSWORD }),
      signup({ username: uniqueUsername(), email: upper(email), password: PASSWORD, inviteToken: token }),
    ]);
    expect(activated.status).toBe(200);
    expect(signedUp.status).toBe(400);
    expect(await accountsFor(email)).toBe(1);
    expect((await prisma.user.findFirstOrThrow({ where: { email }, select: { status: true } })).status).toBe('ACTIVE');
  });
});

describe('Stage 6B — pending R2: cross-path races (need the lower(email) unique index)', () => {
  it('B1 (#1) sign-up vs Team Lead → Member provisioning: one account, the held provisioning gets 409', async (ctx) => {
    if (!runIndexTests) ctx.skip();
    const email = uniqueEmail();
    const { token } = await invite(email);
    const { held, other } = await race(
      email, // provisioning stores lower case
      () => provisionMember(email),
      () => signup({ username: uniqueUsername(), email: upper(email), password: PASSWORD, inviteToken: token })
    );
    expect(other.status).toBe(201);
    expect(held.status).toBe(409);
    expect(await accountsFor(email)).toBe(1);
  }, 30_000);

  it('B1b (#1) Team Lead → Member provisioning vs a held sign-up: one account, the sign-up is refused', async (ctx) => {
    if (!runIndexTests) ctx.skip();
    const email = uniqueEmail();
    const typed = upper(email);
    const { token } = await invite(email);
    const { held, other } = await race(
      typed,
      () => signup({ username: uniqueUsername(), email: typed, password: PASSWORD, inviteToken: token }),
      () => provisionMember(email)
    );
    expect(other.status).toBe(201);
    expect(held.status).toBe(400); // the existing duplicate answer (Stage 6C maps the unique violation; was 500, IDN-4)
    expect(held.body.error).toBe('A user with this email or username already exists');
    expect(await accountsFor(email)).toBe(1);
  }, 30_000);

  it('B2 (#2) sign-up vs admin "Create user": one account, the held admin request gets 409', async (ctx) => {
    if (!runIndexTests) ctx.skip();
    const email = uniqueEmail();
    const loginId = upper(email); // admin "Create user" stores the login as typed
    const { token } = await invite(email);
    const { held, other } = await race(
      loginId,
      () => adminCreate(loginId),
      () => signup({ username: uniqueUsername(), email: capitalised(email), password: PASSWORD, inviteToken: token })
    );
    expect(other.status).toBe(201);
    expect(held.status).toBe(409);
    expect(await accountsFor(email)).toBe(1);
  }, 30_000);

  it('B3 (#3) two provisioning requests in different letter case (admin "Create user" vs Team Lead): one account', async (ctx) => {
    if (!runIndexTests) ctx.skip();
    const email = uniqueEmail();
    const loginId = upper(email);
    const { held, other } = await race(loginId, () => adminCreate(loginId), () => provisionMember(capitalised(email)));
    expect(other.status).toBe(201);
    expect(held.status).toBe(409);
    expect(await accountsFor(email)).toBe(1);
  }, 30_000);

  it('B3b (#3) two admin "Create user" requests in different letter case: one account', async (ctx) => {
    if (!runIndexTests) ctx.skip();
    const email = uniqueEmail();
    const loginId = upper(email);
    const { held, other } = await race(loginId, () => adminCreate(loginId), () => adminCreate(capitalised(email)));
    expect(other.status).toBe(201);
    expect(held.status).toBe(409);
    expect(await accountsFor(email)).toBe(1);
  }, 30_000);

  it('B4 (IDN-2) admin "Create user" cannot add a letter-case twin of a login containing "\\" (ILIKE escape), even without a race', async (ctx) => {
    if (!runIndexTests) ctx.skip();
    const base = uniqueEmail().replace('@', '\\q@'); // test-<uuid>\q@example.com
    expect((await adminCreate(base)).status).toBe(201);
    expect((await adminCreate(upper(base))).status).toBe(409);
    expect(await accountsFor(base)).toBe(1);
  });

  it('B5 (#6) the database admits one account per address under concurrent inserts', async (ctx) => {
    if (!runIndexTests) ctx.skip();
    const email = uniqueEmail();
    const [local, domain] = email.split('@');
    const forms = [email, upper(email), capitalised(email), `${local}@${domain.toUpperCase()}`, `${local.toUpperCase()}@${domain}`, `${local.slice(0, 4).toUpperCase()}${local.slice(4)}@${domain}`];
    expect(new Set(forms).size).toBe(forms.length);
    const results = await Promise.allSettled(forms.map((form) => prisma.user.create({ data: { email: form, username: uniqueUsername(), password: 'not-a-login' } })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'fulfilled') continue;
      expect(r.reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(r.reason.code).toBe('P2002');
      expect(r.reason.meta?.target).toEqual(['lower(email)']);
    }
    expect(await accountsFor(email)).toBe(1);
  });
});

describe('Stage 6B — R1: an invitation revoked while its sign-up is in flight (fixed in 6C)', () => {
  it('C1 (#5) revocation that commits before the account does means no account', async () => {
    const email = uniqueEmail();
    const invitation = await invite(email);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    // Hold the per-address sign-up lock so the sign-up stops inside its transaction, after the gate.
    const holder = prisma.$transaction(
      async (tx) => {
        await lockSignupEmail(tx, email);
        holding = true;
        await released;
      },
      { timeout: 30_000, maxWait: 5_000 }
    );
    await waitFor(() => holding, 'the lock holder');
    const signedUp = (async () => await signup({ username: uniqueUsername(), email, password: PASSWORD, inviteToken: invitation.token }))();
    try {
      await waitFor(async () => (await waitsOnAdvisoryLock()) > 0, 'the sign-up to wait on the per-address lock');
      expect((await as(lead).del(`/api/workspaces/${workspaceId}/invitations/${invitation.id}`)).status).toBe(200);
    } finally {
      release();
      await holder;
    }
    const res = await signedUp;
    expect(res.status).toBe(403); // the gate's uniform invitation-only answer
    expect(await accountsFor(email)).toBe(0);
  }, 30_000);
});

describe('Stage 6B — IDN-3: "_" and "%" in an address are literal characters (fixed in 6C)', () => {
  it('D1 Team Lead provisioning of john_doe-style addresses is not refused because of a different existing account', async () => {
    const existing = await createAndLoginUser(); // test-<uuid>@example.com
    const different = existing.user.email.replace(/^test-/, 'test_'); // a different mailbox
    const res = await provisionMember(different);
    expect(res.body.user?.id).not.toBe(existing.user.id); // today: the other account's id, username and name come back
    expect(res.status).toBe(201);
  });
});
