import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { authHeader, createAndLoginUser } from './helpers';

describe('admin route gating', () => {
  it('denies a regular user access to admin routes', async () => {
    const { token } = await createAndLoginUser({ role: 'USER' });

    const res = await request(app).get('/api/admin/stats').set(authHeader(token));
    expect(res.status).toBe(403);
  });

  it('allows an admin user to reach admin routes', async () => {
    const { token } = await createAndLoginUser({ role: 'ADMIN' });

    const res = await request(app).get('/api/admin/stats').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('re-checks the database role rather than trusting the JWT alone', async () => {
    // Regression guard for the exact thing admin.middleware.ts's comment
    // calls out: a stale token must not still work after a demotion.
    const { user, token } = await createAndLoginUser({ role: 'ADMIN' });

    const { prisma } = await import('../lib/prisma');
    await prisma.user.update({ where: { id: user.id }, data: { role: 'USER' } });

    const res = await request(app).get('/api/admin/stats').set(authHeader(token));
    expect(res.status).toBe(403);
  });
});
