import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';
import { addToWorkspace, createDM, createWorkspace } from './collab-helpers';

/**
 * P2 Phase E — 1:1 DMs belong to a workspace. The same two people get one DM
 * per workspace they share (never the other workspace's conversation), the
 * other person must be a member of the workspace the DM is opened in, and
 * concurrent "open DM" requests never create duplicates.
 */
const dmsBetween = (workspaceId: string, a: string, b: string) =>
  prisma.channel.findMany({
    where: { workspaceId, isDM: true, isGroupDM: false, AND: [{ members: { some: { userId: a } } }, { members: { some: { userId: b } } }] },
    select: { id: true },
  });

describe('1:1 DMs are scoped to a workspace (P2 Phase E)', () => {
  it('gives the same pair a separate DM in each shared workspace, and reuses it within one', async () => {
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const one = await createWorkspace(alice);
    const two = await createWorkspace(alice);
    await addToWorkspace(bob, one.workspaceId);
    await addToWorkspace(bob, two.workspaceId);

    const dmOne = await createDM(alice, bob, one.workspaceId);
    const dmTwo = await createDM(alice, bob, two.workspaceId);
    expect(dmTwo.id).not.toBe(dmOne.id);

    const [rowOne, rowTwo] = await Promise.all([
      prisma.channel.findUnique({ where: { id: dmOne.id }, select: { workspaceId: true } }),
      prisma.channel.findUnique({ where: { id: dmTwo.id }, select: { workspaceId: true } }),
    ]);
    expect(rowOne?.workspaceId).toBe(one.workspaceId);
    expect(rowTwo?.workspaceId).toBe(two.workspaceId);

    // Re-opening (from either side) returns that workspace's conversation.
    expect((await createDM(bob, alice, one.workspaceId)).id).toBe(dmOne.id);
    expect((await createDM(bob, alice, two.workspaceId)).id).toBe(dmTwo.id);
  });

  it("refuses a DM with someone outside the requested workspace instead of using another one", async () => {
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const shared = await createWorkspace(alice);
    const alicesOwn = await createWorkspace(alice);
    await addToWorkspace(bob, shared.workspaceId);

    const res = await request(app)
      .post('/api/channels/dm')
      .set(authHeader(alice.token))
      .send({ targetUserId: bob.user.id, workspaceId: alicesOwn.workspaceId });
    expect(res.status).toBe(403);
    expect(await dmsBetween(shared.workspaceId, alice.user.id, bob.user.id)).toHaveLength(0);
    expect(await dmsBetween(alicesOwn.workspaceId, alice.user.id, bob.user.id)).toHaveLength(0);

    const bad = await request(app)
      .post('/api/channels/dm')
      .set(authHeader(alice.token))
      .send({ targetUserId: bob.user.id, workspaceId: 'not-a-uuid' });
    expect(bad.status).toBe(400);
  });

  it('never creates duplicates under concurrent requests from both sides', async () => {
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const ws = await createWorkspace(alice);
    await addToWorkspace(bob, ws.workspaceId);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app)
          .post('/api/channels/dm')
          .set(authHeader(i % 2 ? alice.token : bob.token))
          .send({ targetUserId: i % 2 ? bob.user.id : alice.user.id, workspaceId: ws.workspaceId })
      )
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await dmsBetween(ws.workspaceId, alice.user.id, bob.user.id)).toHaveLength(1);
  });
});
