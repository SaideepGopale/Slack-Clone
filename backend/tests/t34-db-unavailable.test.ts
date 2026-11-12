import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.middleware';
import { freePort, ServerProcess, startServerProcess } from './server-process';

/**
 * T.34 — administrator login answered 500 "Something went wrong on our side"
 * because the database (the Docker Postgres container) was unreachable:
 * Prisma throws PrismaClientInitializationError, which the error handler did
 * not recognise, so an outage looked like an application bug.
 *
 * An unreachable database is a temporary outage: 503 with Retry-After, a
 * message that says so, and no internal detail (host, port, Prisma text).
 * Unexpected errors stay a generic 500.
 */

const UNAVAILABLE = 'SmartConnect is temporarily unavailable. Please try again in a moment.';
const LEAKS = /localhost|127\.0\.0\.1|prisma|database server|P10\d\d|P2024|:\d{4,5}/i;

const run = (err: unknown) => {
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    setHeader: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
  };
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorHandler(err, {} as never, res as never, vi.fn());
  log.mockRestore();
  info.mockRestore();
  return { status: res.status.mock.calls[0][0] as number, body: res.json.mock.calls[0][0] as { error: string }, headers };
};

describe('T.34 — database outages are a 503, not a 500', () => {
  it('maps every Prisma "cannot reach / lost / timed out" error to 503 with Retry-After and no internals', () => {
    const detail = "Can't reach database server at `localhost:15432`\n\nPlease make sure your database server is running at `localhost:15432`.";
    const cases: unknown[] = [
      // What Prisma 6 throws on the first query when Postgres is down (no errorCode).
      new Prisma.PrismaClientInitializationError(detail, '6.19.3'),
      new Prisma.PrismaClientInitializationError(detail, '6.19.3', 'P1001'),
      ...['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].map((code) => new Prisma.PrismaClientKnownRequestError(detail, { code, clientVersion: '6.19.3' })),
    ];
    for (const err of cases) {
      const out = run(err);
      expect(out.status).toBe(503);
      expect(out.body).toEqual({ error: UNAVAILABLE });
      expect(out.headers['retry-after']).toMatch(/^\d+$/);
      expect(JSON.stringify(out.body)).not.toMatch(LEAKS);
    }
  });

  it('leaves everything else alone: data errors keep their status, unexpected errors stay a generic 500', () => {
    expect(run(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 't' })).status).toBe(409);
    const unexpected = run(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(unexpected.status).toBe(500);
    expect(unexpected.headers['retry-after']).toBeUndefined();
    expect(run(Object.assign(new Error('Invalid credentials'), { status: 401 })).body).toEqual({ error: 'Invalid credentials' });
  });
});

/**
 * The real server, started with a DATABASE_URL whose port has nothing
 * listening — the same state as the Docker database being down. No mocks.
 */
describe('T.34 — the running server with its database down', () => {
  const SECRET = 't34-local-only-secret';
  let server: ServerProcess;
  let url = '';

  beforeAll(async () => {
    const deadDbPort = await freePort(); // nothing listens there
    server = await startServerProcess({
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://nobody@127.0.0.1:${deadDbPort}/unreachable?connect_timeout=2`,
      JWT_SECRET: SECRET,
    });
    url = server.url;
  }, 60_000);

  afterAll(() => server?.stop());

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('administrator login answers 503 "temporarily unavailable", not 500, and leaks nothing', async () => {
    const res = await post('/api/auth/login', { email: 'admin@example.test', password: 'whatever-password' });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: UNAVAILABLE });
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(text).not.toMatch(LEAKS);
    // The detail is still in the server log for the operator.
    expect(server.output()).toMatch(/PrismaClientInitializationError|Can't reach database server/);
  }, 20_000);

  it('a signed-in request answers 503 (not 401), so an outage does not sign people out', async () => {
    const token = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', sid: 's1' }, SECRET, { algorithm: 'HS256', expiresIn: '5m' });
    const res = await fetch(`${url}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: UNAVAILABLE });
  }, 20_000);

  it('requests that never reach the database keep their own answers', async () => {
    expect((await post('/api/auth/login', { email: 'admin@example.test' })).status).toBe(400);
    expect((await fetch(`${url}/api/auth/me`)).status).toBe(401);
    expect((await fetch(`${url}/api/ready`)).status).toBe(503);
  }, 20_000);
});
