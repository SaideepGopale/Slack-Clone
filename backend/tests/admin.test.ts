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

describe('POST /api/admin/broadcast', () => {
  it('lets an admin post an announcement into any channel, delivered as a real message', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const owner = await createAndLoginUser();

    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.token))
      .send({ name: `Broadcast Test Workspace ${Date.now()}` });
    const channelId = createRes.body.generalChannel.id;

    const res = await request(app)
      .post('/api/admin/broadcast')
      .set(authHeader(admin.token))
      .send({ channelId, content: 'Scheduled maintenance tonight at 10pm.' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      channelId,
      content: 'Scheduled maintenance tonight at 10pm.',
      sender: { id: admin.user.id },
    });

    // A regular admin-panel action, not a workspace-membership requirement —
    // the admin never joined this workspace, and broadcasting still works.
    const messagesRes = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.token));
    expect(messagesRes.body.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'Scheduled maintenance tonight at 10pm.' })])
    );
  });

  it('rejects a broadcast with no content', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const owner = await createAndLoginUser();
    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.token))
      .send({ name: `Broadcast Test Workspace ${Date.now()}` });
    const channelId = createRes.body.generalChannel.id;

    const res = await request(app)
      .post('/api/admin/broadcast')
      .set(authHeader(admin.token))
      .send({ channelId, content: '   ' });
    expect(res.status).toBe(400);
  });

  it('denies broadcast access to a non-admin', async () => {
    const { token } = await createAndLoginUser({ role: 'USER' });
    const res = await request(app)
      .post('/api/admin/broadcast')
      .set(authHeader(token))
      .send({ channelId: 'does-not-matter', content: 'hello' });
    expect(res.status).toBe(403);
  });
});
