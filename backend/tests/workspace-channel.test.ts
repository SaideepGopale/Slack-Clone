import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { authHeader, createAndLoginUser } from './helpers';

describe('workspace + channel lifecycle', () => {
  it('creates a workspace with a seeded General channel, and lets the owner create more channels', async () => {
    const { token } = await createAndLoginUser();

    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(token))
      .send({ name: `Test Workspace ${Date.now()}` });
    expect(createRes.status).toBe(201);
    expect(createRes.body.workspace.id).toBeTruthy();
    expect(createRes.body.generalChannel).toMatchObject({ name: 'General' });

    const workspaceId = createRes.body.workspace.id;

    const listRes = await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(token));
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'General' })])
    );

    const newChannelRes = await request(app)
      .post('/api/channels')
      .set(authHeader(token))
      .send({ workspaceId, name: 'random' });
    expect(newChannelRes.status).toBe(201);
    expect(newChannelRes.body).toMatchObject({ name: 'random', workspaceId });
  });

  it('rejects channel creation with a reserved name', async () => {
    const { token } = await createAndLoginUser();
    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(token))
      .send({ name: `Test Workspace ${Date.now()}` });
    const workspaceId = createRes.body.workspace.id;

    const res = await request(app)
      .post('/api/channels')
      .set(authHeader(token))
      .send({ workspaceId, name: 'General' });
    expect(res.status).toBe(400);
  });

  it('denies workspace access to someone who is not a member', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();

    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.token))
      .send({ name: `Private Workspace ${Date.now()}` });
    const workspaceId = createRes.body.workspace.id;

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(outsider.token));
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated workspace creation request', async () => {
    const res = await request(app).post('/api/workspaces').send({ name: 'No Auth Workspace' });
    expect(res.status).toBe(401);
  });
});
