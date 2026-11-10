import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ gets: [] as { url: string; params?: unknown }[] }));
vi.mock('axios', () => ({
  default: {
    get: async (url: string, config?: { params?: unknown }) => {
      calls.gets.push({ url, params: config?.params });
      if (url.endsWith('/participants')) {
        return {
          data: {
            participants: [
              { id: 'me', username: 'mia' },
              { id: 'b', username: 'bob' },
              { id: 'r', username: 'robert' },
              { id: 'c', username: 'carol' },
            ],
          },
        };
      }
      return { data: { members: [{ user: { id: 'me', username: 'mia' } }, { user: { id: 'a', username: 'alice' } }] } };
    },
  },
}));

import { fetchMentionCandidates } from './mentionCandidates';

beforeEach(() => {
  calls.gets.length = 0;
});

describe('mention candidates (P3)', () => {
  it('channels: asks the server for matching members, never suggesting yourself', async () => {
    const people = await fetchMentionCandidates({ id: 'c1', isDM: false }, 'al', 'me');
    expect(calls.gets).toEqual([{ url: '/api/channels/c1/members', params: { q: 'al', limit: 8 } }]);
    expect(people).toEqual([{ id: 'a', username: 'alice' }]);
  });

  it('DMs and group DMs: suggests the conversation’s own participants, best matches first', async () => {
    const people = await fetchMentionCandidates({ id: 'dm1', isDM: true }, 'b', 'me');
    expect(calls.gets.map((c) => c.url)).toEqual(['/api/channels/dm1/participants']);
    // "bob" starts with the query, "robert" only contains it; "mia" is you.
    expect(people.map((p) => p.username)).toEqual(['bob', 'robert']);
  });

  it('DMs: an empty query lists everyone else in the conversation', async () => {
    const people = await fetchMentionCandidates({ id: 'dm1', isDM: true }, '', 'me');
    expect(people.map((p) => p.username)).toEqual(['bob', 'carol', 'robert']);
  });
});
