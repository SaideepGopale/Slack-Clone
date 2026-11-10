import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../app';
import { CONVERSATION_WRITE_LIMIT } from '../modules/channels/channels.routes';
import { SEARCH_LIMIT } from '../modules/messages/messages.routes';
import { authHeader, createAndLoginUser } from './helpers';
import { createWorkspace } from './collab-helpers';

/**
 * P3 (FA-SEC-06): conversation creation/joins and in-channel search were not
 * rate limited. Each is now limited per user. The app's limiters are skipped
 * under NODE_ENV=test, so these tests switch that off for their own requests.
 */
const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('per-user rate limits (P3)', () => {
  it('limits creating and joining conversations', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner);
    process.env.NODE_ENV = 'development';
    // Invalid bodies are rejected (400) after counting toward the limit.
    for (let i = 0; i < CONVERSATION_WRITE_LIMIT; i++) {
      expect((await request(app).post('/api/channels/dm').set(authHeader(owner.token)).send({})).status).toBe(400);
    }
    const limited = await request(app).post('/api/channels/dm').set(authHeader(owner.token)).send({ workspaceId });
    expect(limited.status).toBe(429);
    // The same budget covers channel creation and joins.
    expect((await request(app).post('/api/channels').set(authHeader(owner.token)).send({ workspaceId, name: 'x' })).status).toBe(429);
  });

  it('limits searching a conversation', async () => {
    const owner = await createAndLoginUser();
    const { generalChannelId } = await createWorkspace(owner);
    process.env.NODE_ENV = 'development';
    for (let i = 0; i < SEARCH_LIMIT; i++) {
      const res = await request(app).get(`/api/channels/${generalChannelId}/search`).query({ q: 'hello' }).set(authHeader(owner.token));
      expect(res.status).toBe(200);
    }
    const limited = await request(app).get(`/api/channels/${generalChannelId}/search`).query({ q: 'hello' }).set(authHeader(owner.token));
    expect(limited.status).toBe(429);
  });
});
