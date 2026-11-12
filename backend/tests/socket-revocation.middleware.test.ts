import express from 'express';
import http from 'http';
import { once } from 'events';
import { AddressInfo } from 'net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-B — FA-RT-03: unit tests for the deletion observer
 * (middleware/socketRevocation.middleware.ts). Database-free: the admin router
 * is a stand-in and kickUserSockets is a spy. The real end-to-end behaviour
 * (real app, sockets and database) is in socket-revocation.test.ts.
 */
const kicks = vi.hoisted(() => [] as string[]);
vi.mock('../sockets/registry', () => ({ kickUserSockets: (userId: string) => kicks.push(userId) }));

import { revokeSocketsOnUserDeletion } from '../middleware/socketRevocation.middleware';

// Mounted exactly like app.ts: the observer first, then the (stand-in) admin router.
const buildApp = () => {
  const app = express();
  app.use('/api/admin', revokeSocketsOnUserDeletion);
  const admin = express.Router();
  admin.delete('/users/:id', (req, res) => {
    res.status(Number(req.header('x-status') ?? 200)).json({ deleted: req.params.id });
  });
  admin.post('/users/:id/ban', (_req, res) => res.json({ ok: true }));
  admin.patch('/users/:id/status', (_req, res) => res.json({ ok: true }));
  admin.delete('/messages/:id', (_req, res) => res.json({ ok: true }));
  app.use('/api/admin', admin);
  return app;
};

beforeEach(() => {
  kicks.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('revokeSocketsOnUserDeletion (FA-RT-03)', () => {
  it('revokes the deleted user after a successful deletion and leaves the response untouched', async () => {
    const res = await request(buildApp()).delete('/api/admin/users/u-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 'u-1' });
    expect(kicks).toEqual(['u-1']);
  });

  it('matches the deletion route the same way Express routes it', async () => {
    const app = buildApp();
    expect((await request(app).delete('/API/Admin/USERS/u-2')).status).toBe(200); // case-insensitive routing
    expect((await request(app).delete('/api/admin/users/u-3/')).status).toBe(200); // optional trailing slash
    expect((await request(app).delete('/api/admin/users/a%40b')).body).toEqual({ deleted: 'a@b' }); // decoded like req.params
    expect(kicks).toEqual(['u-2', 'u-3', 'a@b']);
  });

  it('revokes nothing when the deletion is refused or fails', async () => {
    const app = buildApp();
    for (const status of [400, 401, 403, 404, 500]) {
      expect((await request(app).delete('/api/admin/users/u-4').set('x-status', String(status))).status).toBe(status);
    }
    expect(kicks).toEqual([]);
  });

  it('ignores every other admin request', async () => {
    const app = buildApp();
    await request(app).post('/api/admin/users/u-5/ban');
    await request(app).patch('/api/admin/users/u-5/status');
    await request(app).delete('/api/admin/messages/m-1');
    await request(app).get('/api/admin/users/u-5');
    await request(app).delete('/api/admin/users/u-5/extra');
    await request(app).delete('/api/admin/users/');
    expect(kicks).toEqual([]);
  });

  it('a malformed user id is rejected by Express itself and revokes nothing', async () => {
    const res = await request(buildApp()).delete('/api/admin/users/%E0%A4%A');
    expect(res.status).toBe(400);
    expect(kicks).toEqual([]);
  });

  it("still revokes when the admin's own connection drops before the response is written", async () => {
    // The 'finish' event never fires in this case, which is why the observer hooks res.end.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let serverRes!: express.Response;
    const app = express();
    const arrived = new Promise<void>((resolve) => {
      app.use('/api/admin', revokeSocketsOnUserDeletion);
      app.delete('/api/admin/users/:id', async (_req, res) => {
        serverRes = res;
        resolve();
        await gate; // the deletion is still running...
        res.json({ message: 'User deleted successfully' });
      });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const client = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'DELETE', path: '/api/admin/users/u-6' });
      client.on('error', () => undefined);
      client.end();
      await arrived;
      let finished = false;
      serverRes.on('finish', () => (finished = true));
      const closed = once(serverRes, 'close');
      client.destroy(); // ...when the admin's tab/network goes away
      await closed;
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(finished).toBe(false);
      expect(kicks).toEqual(['u-6']);
    } finally {
      server.close();
    }
  });

  it('sweeps a second time shortly after, for a session that was mid-handshake during the first', () => {
    vi.useFakeTimers();
    const res = { statusCode: 200, end: vi.fn() } as unknown as express.Response;
    const next = vi.fn();
    revokeSocketsOnUserDeletion({ method: 'DELETE', path: '/users/u-7' } as express.Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.end();
    expect(kicks).toEqual(['u-7']);
    vi.advanceTimersByTime(1_999);
    expect(kicks).toEqual(['u-7']);
    vi.advanceTimersByTime(1);
    expect(kicks).toEqual(['u-7', 'u-7']);
    res.end(); // a second end() call is not a second deletion
    vi.advanceTimersByTime(5_000);
    expect(kicks).toEqual(['u-7', 'u-7']);
  });
});
