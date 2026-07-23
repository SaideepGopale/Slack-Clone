import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';

// There is no REST "create message" endpoint in this app — messages are
// created over Socket.IO (see sockets/messages.handlers.ts), which is out of
// scope for these integration tests (see manual QA checklist). These tests
// instead seed a message directly via Prisma and exercise the REST surface
// that actually exists for messages: reading, searching, threading, and
// reacting.
const createWorkspaceWithChannel = async (token: string) => {
  const res = await request(app)
    .post('/api/workspaces')
    .set(authHeader(token))
    .send({ name: `Msg Test Workspace ${Date.now()}` });
  return { workspaceId: res.body.workspace.id, channelId: res.body.generalChannel.id };
};

describe('channel messages', () => {
  it('lets a channel member read seeded messages, but denies a non-member', async () => {
    const owner = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId, channelId } = await createWorkspaceWithChannel(owner.token);

    const message = await prisma.message.create({
      data: {
        content: 'hello from the test suite',
        channelId,
        workspaceId,
        senderId: owner.user.id,
      },
    });

    const memberRes = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.token));
    expect(memberRes.status).toBe(200);
    expect(memberRes.body.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id, content: message.content })])
    );

    const nonMemberRes = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(outsider.token));
    expect(nonMemberRes.status).toBe(403);
  });

  it('toggles a reaction on a message and reflects it in the grouped summary', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, channelId } = await createWorkspaceWithChannel(owner.token);

    const message = await prisma.message.create({
      data: { content: 'react to me', channelId, workspaceId, senderId: owner.user.id },
    });

    const addRes = await request(app)
      .post(`/api/messages/${message.id}/reactions`)
      .set(authHeader(owner.token))
      .send({ emoji: '👍' });
    expect(addRes.status).toBe(200);
    expect(addRes.body.reactions).toEqual(
      expect.arrayContaining([expect.objectContaining({ emoji: '👍', count: 1 })])
    );

    // Toggling the same emoji again removes it.
    const removeRes = await request(app)
      .post(`/api/messages/${message.id}/reactions`)
      .set(authHeader(owner.token))
      .send({ emoji: '👍' });
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.reactions).toEqual([]);
  });

  it('returns a thread with its replies', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, channelId } = await createWorkspaceWithChannel(owner.token);

    const parent = await prisma.message.create({
      data: { content: 'parent message', channelId, workspaceId, senderId: owner.user.id },
    });
    await prisma.message.create({
      data: { content: 'a reply', channelId, workspaceId, senderId: owner.user.id, parentId: parent.id },
    });

    const res = await request(app).get(`/api/messages/${parent.id}/thread`).set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.parent).toMatchObject({ id: parent.id });
    expect(res.body.replies).toHaveLength(1);
  });
});
