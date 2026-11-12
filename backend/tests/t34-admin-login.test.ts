import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, uniqueEmail, uniqueUsername } from './helpers';
import { freePort, ServerProcess, startServerProcess } from './server-process';

/**
 * T.34 — administrator sign-in, end to end through the API, against the
 * disposable test database. Regression coverage for the flow the admin login
 * page uses (POST /api/auth/login → /admin, which loads /api/admin/stats).
 */

const PASSWORD = 'Admin-pass-T34!';

const makeAccount = async (role: 'ADMIN' | 'USER', status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' = 'ACTIVE') => {
  const email = uniqueEmail();
  await prisma.user.create({ data: { email, username: uniqueUsername(), password: await bcrypt.hash(PASSWORD, 12), role, status } });
  return email;
};

const login = (email: string, password = PASSWORD) => request(app).post('/api/auth/login').send({ email, password });

describe('T.34 — administrator login', () => {
  it('a valid administrator signs in, gets the ADMIN role, and reaches the admin dashboard API', async () => {
    const email = await makeAccount('ADMIN');
    const res = await login(email);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email, role: 'ADMIN' });
    expect(typeof res.body.token).toBe('string');
    expect((await request(app).get('/api/admin/stats').set(authHeader(res.body.token))).status).toBe(200);
    // A page refresh re-validates the stored token: still the same admin.
    const me = await request(app).get('/api/auth/me').set(authHeader(res.body.token));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email, role: 'ADMIN' });
  });

  it('a wrong password and an unknown account get the same 401, with nothing about which was wrong', async () => {
    const email = await makeAccount('ADMIN');
    const wrong = await login(email, 'Not-the-password-1!');
    const unknown = await login(uniqueEmail());
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'Invalid credentials' });
    expect(unknown.body).toEqual(wrong.body);
  });

  it('a suspended or banned administrator is refused at sign-in (403) and gets no token', async () => {
    for (const status of ['SUSPENDED', 'BANNED'] as const) {
      const res = await login(await makeAccount('ADMIN', status));
      expect(res.status).toBe(403);
      expect(res.body.token).toBeUndefined();
      expect(res.body.error).toMatch(status === 'BANNED' ? /banned/ : /suspended/);
    }
  });

  it('logout revokes the session: the same token no longer reaches /me or the admin API', async () => {
    const { body } = await login(await makeAccount('ADMIN'));
    expect((await request(app).post('/api/auth/logout').set(authHeader(body.token))).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(authHeader(body.token))).status).toBe(401);
    expect((await request(app).get('/api/admin/stats').set(authHeader(body.token))).status).toBe(401);
  });

  it('an expired token for a still-live session is refused with 401', async () => {
    const { body } = await login(await makeAccount('ADMIN'));
    const claims = jwt.decode(body.token) as { id: string; username: string; role: string; sid: string };
    const expired = jwt.sign({ id: claims.id, username: claims.username, role: claims.role, sid: claims.sid }, process.env.JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: -10,
    });
    expect((await request(app).get('/api/auth/me').set(authHeader(expired))).status).toBe(401);
    expect((await request(app).get('/api/admin/stats').set(authHeader(expired))).status).toBe(401);
    // The live token itself still works.
    expect((await request(app).get('/api/admin/stats').set(authHeader(body.token))).status).toBe(200);
  });

  it('a regular user signs in normally and is kept out of the admin API', async () => {
    const res = await login(await makeAccount('USER'));
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('USER');
    expect((await request(app).get('/api/admin/stats').set(authHeader(res.body.token))).status).toBe(403);
  });
});

/**
 * Redis is optional: with REDIS_URL set but Redis down, the rate limiters
 * fail open (passOnStoreError) and sign-in still works. The real server, with
 * the limiters ON (NODE_ENV=development) and a Redis port nothing listens on.
 */
describe('T.34 — administrator login with Redis unreachable', () => {
  let server: ServerProcess;

  beforeAll(async () => {
    server = await startServerProcess({
      NODE_ENV: 'development',
      DATABASE_URL: process.env.DATABASE_URL as string,
      JWT_SECRET: process.env.JWT_SECRET as string,
      REDIS_URL: `redis://127.0.0.1:${await freePort()}`,
    });
  }, 60_000);

  afterAll(() => server?.stop());

  it('signs in and reaches the admin API; readiness reports Redis as down', async () => {
    const email = await makeAccount('ADMIN');
    const started = Date.now();
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.user.role).toBe('ADMIN');
    expect(Date.now() - started).toBeLessThan(10_000);
    const stats = await fetch(`${server.url}/api/admin/stats`, { headers: authHeader(body.token) });
    expect(stats.status).toBe(200);
    const ready = await fetch(`${server.url}/api/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ database: 'ok', redis: 'error' });
  }, 30_000);
});

afterAll(async () => {
  await prisma.$disconnect();
});
