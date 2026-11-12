import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { createWorkspace, invitationFor, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, uniqueEmail, uniqueUsername } from './helpers';

/**
 * P1-C — FA-SEC-02 end to end: attacker-controlled e-mail input is rejected in
 * bounded time on every route that validates it — POST /api/auth/signup and
 * /api/auth/signup-request (unauthenticated) and POST /api/invitations (any
 * signed-in user) — while legitimate signups and invitations work as before.
 * Real app, disposable test database.
 *
 * Before P1-C, ADVERSARIAL held the event loop for ~3 s per request (measured
 * 3.35 s for the pattern alone at 64k characters), and a 1 MB variant for
 * ~14 minutes.
 */
const ADVERSARIAL = `a@${'.'.repeat(60_000)}@`;
const PASSWORD = 'Password123!';
const FAST_MS = 250; // the fixed path answers in a few milliseconds
const INVALID = { error: 'Invalid email format' };

/** A unique, well-formed address of exactly `length` characters. */
const emailOfLength = (length: number) => {
  const tail = `${randomUUID().slice(0, 8)}@example.com`;
  return `${'x'.repeat(length - tail.length)}${tail}`;
};

const timed = async <T>(fn: () => PromiseLike<T>) => {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
};

const signup = (email: unknown, path = '/api/auth/signup', inviteToken?: string) =>
  request(app).post(path).send({ username: uniqueUsername(), email, password: PASSWORD, ...(inviteToken ? { inviteToken } : {}) });
// T.21: sign-up is invitation-only — legitimate sign-ups carry a real invitation.
const invitedSignup = async (email: string) => signup(email, '/api/auth/signup', await invitationFor(email));

describe('signup e-mail validation (FA-SEC-02)', () => {
  it('rejects the adversarial pattern quickly on /signup and /signup-request', async () => {
    for (const path of ['/api/auth/signup', '/api/auth/signup-request']) {
      const { result, ms } = await timed(() => signup(ADVERSARIAL, path));
      expect(result.status, path).toBe(400);
      expect(result.body, path).toEqual(INVALID);
      expect(ms, path).toBeLessThan(FAST_MS);
    }
  });

  it('rejects the adversarial pattern wrapped in a JSON array (no type-coercion bypass)', async () => {
    const { result, ms } = await timed(() => signup([ADVERSARIAL]));
    expect(result.status).toBe(400);
    expect(result.body).toEqual(INVALID);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('rejects extremely long input (about 1 MB) with a 400 before it reaches the database', async () => {
    const huge = emailOfLength(1_000_000);
    const { result, ms } = await timed(() => signup(huge));
    expect(result.status).toBe(400);
    expect(result.body).toEqual(INVALID);
    expect(ms).toBeLessThan(1_000); // includes sending and parsing the ~1 MB body
    expect(await prisma.user.count({ where: { email: huge } })).toBe(0);
  });

  it('boundary lengths: a 254-character address signs up; 255 is rejected', async () => {
    const atLimit = emailOfLength(254);
    const accepted = await invitedSignup(atLimit);
    expect(accepted.status).toBe(201);
    expect(accepted.body.user.email).toBe(atLimit);
    expect(typeof accepted.body.token).toBe('string');

    const overLimit = emailOfLength(255);
    const rejected = await signup(overLimit);
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual(INVALID);
    expect(await prisma.user.count({ where: { email: overLimit } })).toBe(0);
  });

  it('normal addresses still sign up, unchanged', async () => {
    const addresses = [
      uniqueEmail(),
      `first.last+tag-${randomUUID().slice(0, 8)}@sub.example.co.uk`,
      `Mixed.Case_${randomUUID().slice(0, 8)}@Example.COM`,
    ];
    for (const email of addresses) {
      const res = await invitedSignup(email);
      expect(res.status, email).toBe(201);
      expect(res.body.user.email, email).toBe(email);
    }
  });

  it('invalid formats, empty and whitespace-only input are rejected exactly as before', async () => {
    expect((await signup('')).body).toEqual({ error: 'username, email and password are required' });
    for (const email of ['   ', '\t', 'plainaddress', 'a@b', 'a@b.', '@example.com', 'a@@example.com', 'a b@example.com', ' a@example.com']) {
      const res = await signup(email);
      expect(res.status, JSON.stringify(email)).toBe(400);
      expect(res.body, JSON.stringify(email)).toEqual(INVALID);
    }
  });

  it('a burst of adversarial requests does not hold up a legitimate signup', async () => {
    const legitEmail = uniqueEmail();
    const inviteToken = await invitationFor(legitEmail); // issued before the clock starts
    const attacks = Promise.all(Array.from({ length: 3 }, () => signup(ADVERSARIAL)));
    const legit = timed(() => signup(legitEmail, '/api/auth/signup', inviteToken));
    const [rejected, { result, ms }] = await Promise.all([attacks, legit]);
    expect(rejected.map((r) => r.status)).toEqual([400, 400, 400]);
    expect(result.status).toBe(201);
    expect(ms).toBeLessThan(3_000);
  });
});

describe('invitation e-mail validation (FA-SEC-02)', () => {
  const invite = (inviter: TestUser, workspaceId: string, email: unknown) =>
    request(app).post('/api/invitations').set(authHeader(inviter.token)).send({ email, workspaceId });

  it('rejects the adversarial pattern quickly', async () => {
    const inviter = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(inviter);
    const { result, ms } = await timed(() => invite(inviter, workspaceId, ADVERSARIAL));
    expect(result.status).toBe(400);
    expect(result.body).toEqual(INVALID);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('boundary lengths: a 254-character address is invited; 255 is rejected', async () => {
    const inviter = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(inviter);
    const atLimit = emailOfLength(254);
    const accepted = await invite(inviter, workspaceId, atLimit);
    expect(accepted.status).toBe(201);
    expect(accepted.body.success).toBe(true);
    expect(await prisma.invitation.count({ where: { email: atLimit, workspaceId } })).toBe(1);

    const rejected = await invite(inviter, workspaceId, emailOfLength(255));
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual(INVALID);
  });
});
