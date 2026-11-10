import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace, seedMessage } from './collab-helpers';

/**
 * P2 Phase G — the conversation's pinned messages, independent of how much
 * history the client has loaded. Members only.
 */
describe('GET /api/channels/:id/pinned (P2 Phase G)', () => {
  it('lists only pinned top-level messages, newest first, to members', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    const old = await seedMessage(generalChannelId, workspaceId, owner.user.id, '<p>old pin</p>', { isPinned: true, createdAt: new Date(Date.now() - 60_000) });
    await seedMessage(generalChannelId, workspaceId, owner.user.id, '<p>not pinned</p>');
    const recent = await seedMessage(generalChannelId, workspaceId, owner.user.id, '<p>recent pin</p>', { isPinned: true });
    await seedMessage(generalChannelId, workspaceId, owner.user.id, '<p>pinned reply</p>', { isPinned: true, parentId: recent.id });

    const res = await request(app).get(`/api/channels/${generalChannelId}/pinned`).set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.map((m: { id: string }) => m.id)).toEqual([recent.id, old.id]);
    expect(res.body[0]).toMatchObject({ content: '<p>recent pin</p>', sender: { id: owner.user.id } });
    expect(res.body[0].sender.password).toBeUndefined();
  });

  it("refuses people outside the conversation", async () => {
    const owner = await createAndLoginUser();
    const alice = await createAndLoginUser();
    const mallory = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    await addToWorkspace(alice, workspaceId, [generalChannelId]);
    await addToWorkspace(mallory, workspaceId, [generalChannelId]);
    const dm = await createDM(owner, alice, workspaceId);
    await seedMessage(dm.id, workspaceId, owner.user.id, '<p>private pin</p>', { isPinned: true });

    const outsider = await createAndLoginUser();
    expect((await request(app).get(`/api/channels/${generalChannelId}/pinned`).set(authHeader(outsider.token))).status).toBe(403);
    expect((await request(app).get(`/api/channels/${dm.id}/pinned`).set(authHeader(mallory.token))).status).toBe(403);
    expect((await request(app).get(`/api/channels/${dm.id}/pinned`).set(authHeader(alice.token))).status).toBe(200);
  });
});
