import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { createWorkspace, seedMessage } from './collab-helpers';
import { authHeader, createAndLoginUser } from './helpers';

/**
 * T.33 — "N replies" counts are computed for the returned page only (one
 * grouped query) instead of Prisma's whole-table `_count` aggregate. Same
 * `_count.replies` shape, same numbers, on every list that shows them.
 */
describe('reply counts on message lists (T.33)', () => {
  it('history page, thread parent, pinned list and search all report the right counts', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    const busy = await seedMessage(generalChannelId, workspaceId, owner.user.id, 'busy thread zqreply', { isPinned: true });
    const quiet = await seedMessage(generalChannelId, workspaceId, owner.user.id, 'quiet message zqreply');
    for (let i = 0; i < 3; i++) await seedMessage(generalChannelId, workspaceId, owner.user.id, `reply ${i}`, { parentId: busy.id });
    // Counted by parent id, as before (cross-channel replies cannot be created through the API).
    const other = await createWorkspace(owner);
    await prisma.message.create({ data: { channelId: other.generalChannelId, workspaceId: other.workspaceId, senderId: owner.user.id, content: 'stray', parentId: quiet.id } });

    const counts = (list: { id: string; _count: { replies: number } }[]) => Object.fromEntries(list.map((m) => [m.id, m._count.replies]));
    const page = await request(app).get(`/api/channels/${generalChannelId}/messages`).set(authHeader(owner.token));
    expect(page.status).toBe(200);
    expect(counts(page.body.messages)).toMatchObject({ [busy.id]: 3, [quiet.id]: 1 });

    const thread = await request(app).get(`/api/messages/${busy.id}/thread`).set(authHeader(owner.token));
    expect(thread.status).toBe(200);
    expect(thread.body.parent._count.replies).toBe(3);
    expect(thread.body.replies).toHaveLength(3);
    const pinned = await request(app).get(`/api/channels/${generalChannelId}/pinned`).set(authHeader(owner.token));
    expect(counts(pinned.body.messages ?? pinned.body)).toEqual({ [busy.id]: 3 });
    const found = await request(app).get(`/api/channels/${generalChannelId}/search`).query({ q: 'zqreply' }).set(authHeader(owner.token));
    expect(counts(found.body.messages ?? found.body)).toMatchObject({ [busy.id]: 3, [quiet.id]: 1 });
  });
});
