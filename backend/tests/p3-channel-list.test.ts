import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace } from './collab-helpers';

/**
 * P3 (performance audit, measured): the sidebar's channel list embedded every
 * channel's full member roster. In SmartConnect Collab every active user is in
 * General/Announcements/Random, so each sidebar load grew with the user count
 * (2,000 members → ~904 KB per request). Channels now carry a member count;
 * DMs (small by construction) keep their participants, which the UI needs.
 */
describe('channel list payload (P3)', () => {
  it('lists channels with a member count instead of the whole roster', async () => {
    const owner = await createAndLoginUser();
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    await addToWorkspace(alice, workspaceId, [generalChannelId]);
    await addToWorkspace(bob, workspaceId, [generalChannelId]);

    for (const url of [`/api/workspaces/${workspaceId}/channels`, '/api/channels']) {
      const res = await request(app).get(url).set(authHeader(owner.token));
      expect(res.status).toBe(200);
      const general = res.body.find((c: { id: string }) => c.id === generalChannelId);
      expect(general).toBeDefined();
      expect(general).not.toHaveProperty('members');
      expect(general._count).toEqual({ members: 3 });
      expect(JSON.stringify(res.body)).not.toContain(alice.user.username);
    }
  });

  it('still lists DMs with their participants', async () => {
    const owner = await createAndLoginUser();
    const alice = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    await addToWorkspace(alice, workspaceId, [generalChannelId]);
    const dm = await createDM(owner, alice, workspaceId);

    const res = await request(app).get(`/api/workspaces/${workspaceId}/dms`).set(authHeader(owner.token));
    const listed = res.body.find((c: { id: string }) => c.id === dm.id);
    expect(listed.name).toBe(alice.user.username);
    expect(listed.participants.map((p: { id: string }) => p.id).sort()).toEqual([owner.user.id, alice.user.id].sort());
  });
});
