import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/mailer', () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPasswordEmail: vi.fn().mockResolvedValue(undefined),
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

import { app } from '../app';
import { prisma } from '../lib/prisma';
import { isAdminUser } from '../middleware/admin.middleware';
import { sendResetPasswordEmail } from '../utils/mailer';
import { authHeader, createAndLoginUser } from './helpers';
import { useSocketHarness } from './socket-harness';

/**
 * T.32 — audit H1 (REST sessions were never revoked) and H2 (a suspended or
 * banned admin kept the admin API). Every login token is now backed by a
 * server-side AuthSession row checked on every request and socket handshake.
 */
const harness = useSocketHarness();
const PASSWORD = 'Password123!';

const me = (token: string) => request(app).get('/api/auth/me').set(authHeader(token));
const login = (email: string, password = PASSWORD) => request(app).post('/api/auth/login').send({ email, password });

describe('T.32 H1 — server-side session revocation', () => {
  it('logout ends only this session: its token stops working at once, other devices stay signed in', async () => {
    const { user, token } = await createAndLoginUser();
    const second = (await login(user.email)).body.token as string;
    expect((await me(token)).status).toBe(200);

    const out = await request(app).post('/api/auth/logout').set(authHeader(token));
    expect(out.status).toBe(200);
    const after = await me(token);
    expect(after.status).toBe(401);
    expect(after.body.error).toMatch(/session has ended/i);
    expect((await request(app).get('/api/workspaces').set(authHeader(token))).status).toBe(401);
    expect((await me(second)).status).toBe(200);
  });

  it('logout-all ends every session of the account', async () => {
    const { user, token } = await createAndLoginUser();
    const second = (await login(user.email)).body.token as string;
    const res = await request(app).post('/api/auth/logout-all').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.endedSessions).toBe(2);
    expect((await me(token)).status).toBe(401);
    expect((await me(second)).status).toBe(401);
    // Signing in again works normally.
    expect((await me((await login(user.email)).body.token)).status).toBe(200);
  });

  it('banning or suspending a user ends their REST sessions immediately; reactivation does not revive them', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    for (const status of ['BANNED', 'SUSPENDED'] as const) {
      const target = await createAndLoginUser();
      expect((await request(app).get('/api/workspaces').set(authHeader(target.token))).status).toBe(200);
      const changed = await request(app).patch(`/api/admin/users/${target.user.id}/status`).set(authHeader(admin.token)).send({ status });
      expect(changed.status).toBe(200);
      expect((await request(app).get('/api/workspaces').set(authHeader(target.token))).status).toBe(401);
      await request(app).patch(`/api/admin/users/${target.user.id}/status`).set(authHeader(admin.token)).send({ status: 'ACTIVE' });
      expect((await me(target.token)).status).toBe(401); // the old session stays ended
      expect((await login(target.user.email)).status).toBe(200);
    }
  });

  it('a status change made outside the admin flow is still enforced on the next request (status re-checked)', async () => {
    const target = await createAndLoginUser();
    await prisma.user.update({ where: { id: target.user.id }, data: { status: 'SUSPENDED' } });
    const res = await me(target.token);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/suspended/i);
  });

  it('a deleted account\'s token is refused', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const target = await createAndLoginUser();
    expect((await request(app).delete(`/api/admin/users/${target.user.id}`).set(authHeader(admin.token))).status).toBe(200);
    expect((await me(target.token)).status).toBe(401);
    expect(await prisma.authSession.count({ where: { userId: target.user.id } })).toBe(0); // cascaded
  });

  it('a password reset by e-mailed link ends every existing session', async () => {
    const { user, token } = await createAndLoginUser();
    vi.mocked(sendResetPasswordEmail).mockClear();
    expect((await request(app).post('/api/auth/forgot-password').send({ email: user.email })).status).toBe(200);
    const link = new URL(vi.mocked(sendResetPasswordEmail).mock.calls[0][1] as string);
    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ id: link.searchParams.get('id'), token: link.searchParams.get('token'), newPassword: 'a-new-pass-123' });
    expect(reset.status).toBe(200);
    expect((await me(token)).status).toBe(401);
    expect((await login(user.email, 'a-new-pass-123')).status).toBe(200);
    // The link is single-use: the password (and so the link secret) changed.
    const again = await request(app)
      .post('/api/auth/reset-password')
      .send({ id: link.searchParams.get('id'), token: link.searchParams.get('token'), newPassword: 'another-pass-123' });
    expect(again.status).toBe(400);
    const audit = await prisma.auditLog.findFirst({ where: { actorId: user.id, action: 'RESET_PASSWORD' } });
    expect(audit?.details).not.toContain('a-new-pass-123');
  });

  it('an admin setting a password ends the account\'s sessions', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const target = await createAndLoginUser();
    const res = await request(app).post(`/api/admin/users/${target.user.id}/password`).set(authHeader(admin.token)).send({ password: 'set-by-admin-1' });
    expect(res.status).toBe(200);
    expect((await me(target.token)).status).toBe(401);
  });

  it('change-password needs the current password, keeps this session and ends the others', async () => {
    const { user, token } = await createAndLoginUser();
    const other = (await login(user.email)).body.token as string;
    const change = (body: object) => request(app).post('/api/auth/change-password').set(authHeader(token)).send(body);

    expect((await change({ currentPassword: 'wrong-password', newPassword: 'brand-new-1' })).status).toBe(400);
    expect((await change({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await change({ currentPassword: PASSWORD, newPassword: { not: 'a string' } })).status).toBe(400);
    expect((await change({ currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400);
    expect((await me(other)).status).toBe(200); // nothing happened yet

    const ok = await change({ currentPassword: PASSWORD, newPassword: 'brand-new-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.endedSessions).toBe(1);
    expect((await me(token)).status).toBe(200);
    expect((await me(other)).status).toBe(401);
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, 'brand-new-1')).status).toBe(200);
  });

  it('lists the caller\'s own sessions and ends one by id; another user\'s session cannot be ended', async () => {
    const { user, token } = await createAndLoginUser();
    const other = (await login(user.email)).body.token as string;
    const stranger = await createAndLoginUser();

    const list = await request(app).get('/api/auth/sessions').set(authHeader(token));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    const otherSid = list.body.find((s: { current: boolean }) => !s.current).id as string;

    expect((await request(app).delete(`/api/auth/sessions/${otherSid}`).set(authHeader(stranger.token))).status).toBe(404);
    expect((await me(other)).status).toBe(200);
    expect((await request(app).delete(`/api/auth/sessions/${otherSid}`).set(authHeader(token))).status).toBe(200);
    expect((await me(other)).status).toBe(401);
    expect((await me(token)).status).toBe(200);
  });

  it('refuses tokens without a server-side session (pre-T.32 tokens) and tokens pointing at someone else\'s session', async () => {
    const victim = await createAndLoginUser();
    const attacker = await createAndLoginUser();
    const secret = process.env.JWT_SECRET as string;
    const legacy = jwt.sign({ id: victim.user.id, username: victim.user.username, role: 'USER' }, secret, { expiresIn: '7d' });
    expect((await me(legacy)).status).toBe(401);

    const { sid } = jwt.decode(attacker.token) as { sid: string };
    const crossed = jwt.sign({ id: victim.user.id, username: 'x', role: 'ADMIN', sid }, secret, { expiresIn: '7d' });
    expect((await me(crossed)).status).toBe(401);

    // Invalid, expired and malformed tokens are 401 too (the client's "session over" signal).
    expect((await me('not-a-real-token')).status).toBe(401);
    const expired = jwt.sign({ id: victim.user.id, sid, exp: Math.floor(Date.now() / 1000) - 10 }, secret);
    expect((await me(expired)).status).toBe(401);
  });

  it('the request identity comes from the database, not the token claims', async () => {
    const { user, token } = await createAndLoginUser();
    await prisma.user.update({ where: { id: user.id }, data: { username: `${user.username}_renamed` } });
    const res = await me(token);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(`${user.username}_renamed`);
  });
});

describe('T.32 H2 — suspended or banned administrators lose admin access', () => {
  it('isAdminUser requires an ACTIVE account', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    expect(await isAdminUser(admin.user.id)).toBe(true);
    await prisma.user.update({ where: { id: admin.user.id }, data: { status: 'SUSPENDED' } });
    expect(await isAdminUser(admin.user.id)).toBe(false);
    await prisma.user.update({ where: { id: admin.user.id }, data: { status: 'BANNED' } });
    expect(await isAdminUser(admin.user.id)).toBe(false);
    expect(await isAdminUser('')).toBe(false);
  });

  it('a banned admin\'s token can no longer reach the admin API', async () => {
    const actingAdmin = await createAndLoginUser({ role: 'ADMIN' });
    const bannedAdmin = await createAndLoginUser({ role: 'ADMIN' });
    expect((await request(app).get('/api/admin/users').set(authHeader(bannedAdmin.token))).status).toBe(200);
    expect((await request(app).patch(`/api/admin/users/${bannedAdmin.user.id}/status`).set(authHeader(actingAdmin.token)).send({ status: 'BANNED' })).status).toBe(200);
    expect((await request(app).get('/api/admin/users').set(authHeader(bannedAdmin.token))).status).toBe(401);
    expect((await request(app).get('/api/company-overview/summary').set(authHeader(bannedAdmin.token))).status).toBe(401);
  });
});

describe('T.32 H1 — sockets follow the session', () => {
  it('a revoked session cannot open a socket, and logout disconnects that session\'s live sockets only', async () => {
    const { user, token } = await createAndLoginUser();
    const other = (await login(user.email)).body.token as string;
    const a = await harness.connect({ user, token } as never);
    const b = await harness.connect({ user, token: other } as never);
    const disconnected = new Promise<string>((resolve) => a.socket.once('disconnect', (reason) => resolve(reason)));

    expect((await request(app).post('/api/auth/logout').set(authHeader(token))).status).toBe(200);
    expect(await disconnected).toBe('io server disconnect');
    expect(b.socket.connected).toBe(true);

    await expect(harness.connect({ user, token } as never)).rejects.toThrow(/session has ended/i);
  });
});
