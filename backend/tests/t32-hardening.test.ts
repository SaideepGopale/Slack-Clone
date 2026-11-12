import request from 'supertest';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/mailer', () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPasswordEmail: vi.fn().mockResolvedValue(undefined),
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

import { app } from '../app';
import { prisma } from '../lib/prisma';
import { errorHandler } from '../middleware/error.middleware';
import { FORGOT_PASSWORD_LIMIT, INVITATION_LOOKUP_LIMIT } from '../middleware/rateLimit.middleware';
import { isReactionEmoji } from '../modules/messages/messages.controller';
import { resetSocketRateLimits, SOCKET_EVENT_LIMITS, takeSocketEventBudget } from '../sockets/rateLimit';
import { sendResetPasswordEmail } from '../utils/mailer';
import { createWorkspace, seedMessage, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, uniqueEmail } from './helpers';
import { emitAck, useSocketHarness } from './socket-harness';

const harness = useSocketHarness();
const api = (user: TestUser) => ({
  post: (path: string, body: object) => request(app).post(path).set(authHeader(user.token)).send(body),
});
const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
  resetSocketRateLimits();
});

describe('T.32 M1 — password reset hardening', () => {
  it('forgot-password answers identically whether or not the account exists', async () => {
    const { user } = await createAndLoginUser();
    const known = await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: uniqueEmail() });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it('forgot-password is rate limited per IP', async () => {
    process.env.NODE_ENV = 'development';
    let last = 0;
    for (let i = 0; i <= FORGOT_PASSWORD_LIMIT; i++) {
      last = (await request(app).post('/api/auth/forgot-password').send({ email: uniqueEmail() })).status;
    }
    expect(last).toBe(429);
  });

  it('reset-password: an unknown account looks exactly like a bad link, the password rule applies, and bad types are 400 not 500', async () => {
    const { user } = await createAndLoginUser();
    const unknown = await request(app).post('/api/auth/reset-password').send({ id: '00000000-0000-0000-0000-000000000000', token: 'x', newPassword: 'long-enough-1' });
    const badToken = await request(app).post('/api/auth/reset-password').send({ id: user.id, token: 'x', newPassword: 'long-enough-1' });
    expect(unknown.status).toBe(400);
    expect(badToken.status).toBe(400);
    expect(unknown.body).toEqual(badToken.body);

    vi.mocked(sendResetPasswordEmail).mockClear();
    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    const link = new URL(vi.mocked(sendResetPasswordEmail).mock.calls[0][1] as string);
    const send = (newPassword: unknown) =>
      request(app).post('/api/auth/reset-password').send({ id: link.searchParams.get('id'), token: link.searchParams.get('token'), newPassword });
    expect((await send('123')).status).toBe(400);
    expect((await send(['an', 'array'])).status).toBe(400);
    expect((await send('é'.repeat(40))).status).toBe(400); // 80 bytes > bcrypt's 72
    expect((await send('acceptable-1')).status).toBe(200);
  });
});

describe('T.32 M3 — input validation and error responses', () => {
  it('non-string credentials are a 400, never a 500 with internal text', async () => {
    for (const body of [{ email: { a: 1 }, password: 'x' }, { email: 'a@b.c', password: ['x'] }, { email: 42, password: 42 }]) {
      const res = await request(app).post('/api/auth/login').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|invocation|bcrypt/i);
    }
    const signup = await request(app).post('/api/auth/signup').send({ username: ['x'], email: uniqueEmail(), password: 'Password123!' });
    expect([400, 403]).toContain(signup.status);
  });

  it('malformed JSON is a clean 400', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The request body is not valid JSON.');
  });

  it('errorHandler maps database outcomes and hides unexpected internals', () => {
    const run = (err: unknown) => {
      const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() };
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      errorHandler(err, {} as never, res as never, vi.fn());
      log.mockRestore();
      info.mockRestore();
      return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
    };
    const known = (code: string) => new Prisma.PrismaClientKnownRequestError('Invalid `prisma.x.create()` invocation: secret detail', { code, clientVersion: 'test' });
    expect(run(known('P2002')).status).toBe(409);
    expect(run(known('P2025')).status).toBe(404);
    expect(JSON.stringify(run(known('P2002')).body)).not.toContain('secret detail');
    const unexpected = run(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    expect(unexpected.status).toBe(500);
    expect(JSON.stringify(unexpected.body)).not.toMatch(/ECONNREFUSED|hunter2/);
    // Deliberate errors keep their user-facing message.
    expect(run(Object.assign(new Error('Channel not found'), { status: 404 }))).toEqual({ status: 404, body: { error: 'Channel not found' } });
  });
});

describe('T.32 M13 / L9 — reactions and pagination input', () => {
  it('accepts real emoji and rejects text, markup and oversized values', () => {
    for (const ok of ['👍', '🎉', '👍🏽', '👨‍👩‍👧‍👦', '🇮🇳', '1️⃣', '❤️']) expect(isReactionEmoji(ok), ok).toBe(true);
    for (const bad of ['abc', '123', '<b>x</b>', '👍 ', ' ', 'x'.repeat(64), '👍'.repeat(20)]) expect(isReactionEmoji(bad), bad).toBe(false);
  });

  it('rejects a non-emoji reaction with 400 and survives concurrent toggles without a 500', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    const message = await seedMessage(generalChannelId, workspaceId, owner.user.id, 'react to me');
    const react = (emoji: unknown) => api(owner).post(`/api/messages/${message.id}/reactions`, { emoji });

    expect((await react('x'.repeat(5000))).status).toBe(400);
    expect((await react('not an emoji')).status).toBe(400);

    const results = await Promise.all([react('🎉'), react('🎉'), react('🎉'), react('🎉')]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const count = await prisma.reaction.count({ where: { messageId: message.id, userId: owner.user.id, emoji: '🎉' } });
    expect([0, 1]).toContain(count);
  });

  it('message history only accepts a positive whole-number limit', async () => {
    const owner = await createAndLoginUser();
    const { generalChannelId } = await createWorkspace(owner);
    for (const limit of ['10.5', 'abc', '-1', '0']) {
      expect((await request(app).get(`/api/channels/${generalChannelId}/messages`).query({ limit }).set(authHeader(owner.token))).status, limit).toBe(400);
    }
    expect((await request(app).get(`/api/channels/${generalChannelId}/messages`).query({ limit: '20' }).set(authHeader(owner.token))).status).toBe(200);
  });
});

describe('T.32 L3 — invitation lookup throttling', () => {
  it('the public invitation lookup is rate limited per IP', async () => {
    process.env.NODE_ENV = 'development';
    let last = 0;
    for (let i = 0; i <= INVITATION_LOOKUP_LIMIT; i++) last = (await request(app).get(`/api/invitations/not-a-token-${i}`)).status;
    expect(last).toBe(429);
  });
});

describe('T.32 M5 — socket event rate limits', () => {
  it('counts per user and event in fixed windows', () => {
    const { limit, windowMs } = SOCKET_EVENT_LIMITS['call:initiate'];
    const t0 = 1_000_000;
    for (let i = 0; i < limit; i++) expect(takeSocketEventBudget('u-1', 'call:initiate', t0)).toBe(true);
    expect(takeSocketEventBudget('u-1', 'call:initiate', t0)).toBe(false);
    expect(takeSocketEventBudget('u-2', 'call:initiate', t0)).toBe(true); // other users unaffected
    expect(takeSocketEventBudget('u-1', 'message:send', t0)).toBe(true); // other events unaffected
    expect(takeSocketEventBudget('u-1', 'call:initiate', t0 + windowMs)).toBe(true); // next window
  });

  it('an over-limit event is dropped before its handler and the client is told via its ack', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    const { socket } = await harness.connect(owner);
    process.env.NODE_ENV = 'development';
    const { limit } = SOCKET_EVENT_LIMITS['message:send'];
    const acks = [];
    for (let i = 0; i <= limit; i++) {
      acks.push(await emitAck(socket, 'message:send', { channelId: generalChannelId, content: `m${i}`, clientId: `c-${i}-${Date.now()}` }));
    }
    expect(acks.slice(0, limit).every((a) => a.ok)).toBe(true);
    expect(acks[limit]).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(await prisma.message.count({ where: { channelId: generalChannelId, workspaceId, senderId: owner.user.id } })).toBe(limit);
  });
});
