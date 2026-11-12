import { afterAll, describe, expect, it, vi } from 'vitest';

// A distinct frontend URL (with a trailing slash, as people often paste it), set
// before the app's config is loaded, so the tests prove APP_URL is what the
// backend uses — not a hard-coded localhost.
const configured = vi.hoisted(() => {
  const previous = process.env.APP_URL;
  process.env.APP_URL = 'https://smartconnect-frontend.example.test/';
  return { previous, origin: 'https://smartconnect-frontend.example.test' };
});

vi.mock('../utils/mailer', () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPasswordEmail: vi.fn().mockResolvedValue(undefined),
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../app';
import { APP_URL, TRUST_PROXY } from '../config/env';
import { sendResetPasswordEmail } from '../utils/mailer';
import { createAndLoginUser } from './helpers';

/**
 * Render deployment behaviour over HTTP: CORS origins, trust proxy and the
 * password-reset link. Disposable test database only (forgot-password looks
 * the account up).
 */
afterAll(() => {
  if (configured.previous === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = configured.previous;
});

const preflight = (origin: string) =>
  request(app).options('/api/auth/login').set('Origin', origin).set('Access-Control-Request-Method', 'POST');

describe('Render deployment configuration over HTTP', () => {
  it('APP_URL comes from the environment, normalised (no trailing slash)', () => {
    expect(APP_URL).toBe(configured.origin);
  });

  it('CORS: APP_URL and the local dev origins are allowed; any other browser origin is refused', async () => {
    const fromApp = await preflight(configured.origin);
    expect(fromApp.status).toBe(204);
    expect(fromApp.headers['access-control-allow-origin']).toBe(configured.origin);
    expect(fromApp.headers['access-control-allow-credentials']).toBe('true');

    const fromViteDev = await preflight('http://localhost:5174'); // NODE_ENV=test is not production
    expect(fromViteDev.status).toBe(204);
    expect(fromViteDev.headers['access-control-allow-origin']).toBe('http://localhost:5174');

    const fromElsewhere = await preflight('https://evil.example');
    expect(fromElsewhere.status).toBe(403);
    expect(fromElsewhere.headers['access-control-allow-origin']).toBeUndefined();

    // No Origin header (server-to-server, health checks): unaffected.
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(400);
  });

  it('trust proxy is off outside production, so X-Forwarded-For cannot spoof the client address', async () => {
    expect(TRUST_PROXY).toBe(false);
    expect(app.get('trust proxy')).toBe(false);
  });

  it('the password-reset link points at the configured frontend', async () => {
    const { user } = await createAndLoginUser();
    vi.mocked(sendResetPasswordEmail).mockClear();
    const res = await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    expect(res.status).toBe(200);
    expect(sendResetPasswordEmail).toHaveBeenCalledTimes(1);
    const [to, link] = vi.mocked(sendResetPasswordEmail).mock.calls[0];
    expect(to).toBe(user.email);
    expect(link).toMatch(new RegExp(`^${configured.origin.replace(/[.]/g, '\\.')}/reset-password\\?token=[^&]+&id=${user.id}$`));
    expect(link).not.toContain('localhost');
  });
});
