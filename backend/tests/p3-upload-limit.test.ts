import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../app';
import { UPLOAD_LIMIT } from '../modules/uploads/message.routes';
import { authHeader, createAndLoginUser } from './helpers';

/**
 * P3 (file-sharing audit): POST /api/upload had no rate limit, so any signed-in
 * account could loop 25 MB uploads and exhaust the storage quota. Uploads are
 * now limited per user. (The app's limiters are skipped under NODE_ENV=test,
 * so this test switches that off for its own requests only.)
 */
const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('POST /api/upload rate limit (P3)', () => {
  it('limits each user separately and never reaches storage once limited', async () => {
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    process.env.NODE_ENV = 'development';

    // No file attached: these requests stop at "No file was uploaded" (400)
    // without touching storage, but still count toward the limit.
    for (let i = 0; i < UPLOAD_LIMIT.max; i++) {
      const res = await request(app).post('/api/upload').set(authHeader(alice.token));
      expect(res.status).toBe(400);
    }
    const limited = await request(app).post('/api/upload').set(authHeader(alice.token));
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/too many uploads/i);

    // Someone else is unaffected.
    expect((await request(app).post('/api/upload').set(authHeader(bob.token))).status).toBe(400);
  });

  it('still requires a signed-in user before counting anything', async () => {
    expect((await request(app).post('/api/upload')).status).toBe(401);
  });
});
