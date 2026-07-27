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

describe('reusable workspace invite link', () => {
  const createWorkspaceAndLink = async (ownerToken: string) => {
    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(ownerToken))
      .send({ name: `Invite Link Test ${Date.now()}` });
    const workspaceId = createRes.body.workspace.id;
    const generalChannelId = createRes.body.generalChannel.id;

    const linkRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/invite-link`)
      .set(authHeader(ownerToken));
    const token = new URL(linkRes.body.url).searchParams.get('token');

    return { workspaceId, generalChannelId, token };
  };

  it('generates a link (admin only) with the expected /join-workspace shape', async () => {
    const owner = await createAndLoginUser();
    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.token))
      .send({ name: `Invite Link Test ${Date.now()}` });
    const workspaceId = createRes.body.workspace.id;

    const linkRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/invite-link`)
      .set(authHeader(owner.token));
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.url).toContain('/join-workspace?token=');
  });

  it('denies generating a link for a non-admin member', async () => {
    const owner = await createAndLoginUser();
    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.token))
      .send({ name: `Invite Link Test ${Date.now()}` });
    const workspaceId = createRes.body.workspace.id;

    const nonAdmin = await createAndLoginUser();
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/invite-link`)
      .set(authHeader(nonAdmin.token));
    expect(res.status).toBe(403);
  });

  it('rejects joining with a bogus token', async () => {
    const { token } = await createAndLoginUser();
    const res = await request(app)
      .post('/api/workspaces/join')
      .set(authHeader(token))
      .send({ token: 'not-a-real-jwt' });
    expect(res.status).toBe(400);
  });

  it('files a PENDING join request instead of joining instantly, and denies channel access until approved', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId, token } = await createWorkspaceAndLink(owner.token);

    const joinRes = await request(app)
      .post('/api/workspaces/join')
      .set(authHeader(outsider.token))
      .send({ token });
    expect(joinRes.status).toBe(200);
    expect(joinRes.body).toEqual({ status: 'pending' });

    const channelsRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(outsider.token));
    expect(channelsRes.status).toBe(403);
  });

  it('re-requesting while already pending is a harmless no-op', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { token } = await createWorkspaceAndLink(owner.token);

    await request(app).post('/api/workspaces/join').set(authHeader(outsider.token)).send({ token });
    const secondRes = await request(app).post('/api/workspaces/join').set(authHeader(outsider.token)).send({ token });
    expect(secondRes.status).toBe(200);
    expect(secondRes.body).toEqual({ status: 'pending' });
  });

  it('returns already_member for someone who already belongs to the workspace', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId, token } = await createWorkspaceAndLink(owner.token);

    const res = await request(app)
      .post('/api/workspaces/join')
      .set(authHeader(owner.token))
      .send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'already_member', workspaceId, generalChannelId });
  });
});

describe('workspace join request approval', () => {
  const fileJoinRequest = async (ownerToken: string, requesterToken: string) => {
    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(ownerToken))
      .send({ name: `Join Request Test ${Date.now()}` });
    const workspaceId = createRes.body.workspace.id;
    const generalChannelId = createRes.body.generalChannel.id;

    const linkRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/invite-link`)
      .set(authHeader(ownerToken));
    const token = new URL(linkRes.body.url).searchParams.get('token');

    await request(app).post('/api/workspaces/join').set(authHeader(requesterToken)).send({ token });

    const listRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/requests`)
      .set(authHeader(ownerToken));
    const requestId = listRes.body[0].id;

    return { workspaceId, generalChannelId, requestId };
  };

  it('lists pending requests for an admin, including the requester\'s user info', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId } = await fileJoinRequest(owner.token, outsider.token);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/requests`)
      .set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'PENDING', user: expect.objectContaining({ id: outsider.user.id }) }),
      ])
    );
  });

  it('denies listing requests to a non-admin', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId } = await fileJoinRequest(owner.token, outsider.token);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/requests`)
      .set(authHeader(outsider.token));
    expect(res.status).toBe(403);
  });

  it('APPROVE adds the user to the workspace and its General channel', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId, generalChannelId, requestId } = await fileJoinRequest(owner.token, outsider.token);

    const resolveRes = await request(app)
      .put(`/api/workspaces/${workspaceId}/requests/${requestId}`)
      .set(authHeader(owner.token))
      .send({ action: 'APPROVE' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body).toEqual({ status: 'APPROVED' });

    const channelsRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(outsider.token));
    expect(channelsRes.status).toBe(200);
    expect(channelsRes.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: generalChannelId })])
    );
  });

  it('REJECT leaves the user without access, and the request no longer shows as pending', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId, requestId } = await fileJoinRequest(owner.token, outsider.token);

    const resolveRes = await request(app)
      .put(`/api/workspaces/${workspaceId}/requests/${requestId}`)
      .set(authHeader(owner.token))
      .send({ action: 'REJECT' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body).toEqual({ status: 'REJECTED' });

    const channelsRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(outsider.token));
    expect(channelsRes.status).toBe(403);

    const listRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/requests`)
      .set(authHeader(owner.token));
    expect(listRes.body).toEqual([]);
  });

  it('rejects resolving an already-resolved request', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId, requestId } = await fileJoinRequest(owner.token, outsider.token);

    await request(app)
      .put(`/api/workspaces/${workspaceId}/requests/${requestId}`)
      .set(authHeader(owner.token))
      .send({ action: 'APPROVE' });

    const secondResolve = await request(app)
      .put(`/api/workspaces/${workspaceId}/requests/${requestId}`)
      .set(authHeader(owner.token))
      .send({ action: 'REJECT' });
    expect(secondResolve.status).toBe(400);
  });

  it('denies resolving requests to a non-admin', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId, requestId } = await fileJoinRequest(owner.token, outsider.token);

    const res = await request(app)
      .put(`/api/workspaces/${workspaceId}/requests/${requestId}`)
      .set(authHeader(outsider.token))
      .send({ action: 'APPROVE' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/users/me/active-workspace', () => {
  it('updates lastActiveWorkspaceId for a member, and reflects it on the next /me call', async () => {
    const { token } = await createAndLoginUser();
    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(token))
      .send({ name: `Active Workspace Test ${Date.now()}` });
    const workspaceId = createRes.body.workspace.id;

    const patchRes = await request(app)
      .patch('/api/users/me/active-workspace')
      .set(authHeader(token))
      .send({ workspaceId });
    expect(patchRes.status).toBe(204);

    const meRes = await request(app).get('/api/auth/me').set(authHeader(token));
    expect(meRes.body.lastActiveWorkspaceId).toBe(workspaceId);
  });

  it('rejects setting it to a workspace the caller is not a member of', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const createRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.token))
      .send({ name: `Private Active Workspace Test ${Date.now()}` });
    const workspaceId = createRes.body.workspace.id;

    const res = await request(app)
      .patch('/api/users/me/active-workspace')
      .set(authHeader(outsider.token))
      .send({ workspaceId });
    expect(res.status).toBe(403);
  });
});
