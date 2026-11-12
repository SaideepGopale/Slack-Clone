import { describe, expect, it } from 'vitest';
import { createClientId, extractUrls, htmlToText, mergeMessages, PENDING_PREFIX, reconcileLatestWindow, upsertMessage } from './messages';

const msg = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ id, createdAt, ...extra });

describe('mergeMessages', () => {
  it('orders confirmed messages by (createdAt, id) and de-duplicates by id, later list winning', () => {
    const fetched = [msg('b', '2026-01-01T00:00:02Z', { content: 'old' }), msg('a', '2026-01-01T00:00:01Z')];
    const live = [msg('b', '2026-01-01T00:00:02Z', { content: 'new' }), msg('c', '2026-01-01T00:00:02Z')];
    const merged = mergeMessages<{ id: string; createdAt: string; content?: string }>(fetched, live);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(merged.find((m) => m.id === 'b')?.content).toBe('new');
  });

  it('retires an optimistic message once the confirmed copy with the same clientId arrives', () => {
    const pending = msg(`${PENDING_PREFIX}k1`, '2026-01-01T00:00:09Z', { clientId: 'k1', deliveryState: 'pending' as const });
    const confirmed = msg('server-id', '2026-01-01T00:00:05Z', { clientId: 'k1' });
    expect(upsertMessage([pending], confirmed).map((m) => m.id)).toEqual(['server-id']);
    // and arriving twice (ack + live broadcast) still renders once
    expect(upsertMessage(upsertMessage([pending], confirmed), confirmed)).toHaveLength(1);
  });

  it('keeps unconfirmed pending/failed messages after all confirmed ones', () => {
    const pending = msg(`${PENDING_PREFIX}k2`, '2020-01-01T00:00:00Z', { clientId: 'k2', deliveryState: 'failed' as const });
    const merged = mergeMessages([pending], [msg('x', '2026-01-01T00:00:00Z')]);
    expect(merged.map((m) => m.id)).toEqual(['x', `${PENDING_PREFIX}k2`]);
  });
});

describe('text helpers', () => {
  it('htmlToText strips markup, decodes entities and separates blocks', () => {
    expect(htmlToText('<p><strong>Hi</strong> &amp; welcome</p><p>team</p>')).toBe('Hi & welcome team');
    expect(htmlToText(null)).toBe('');
  });

  it('extractUrls finds links in visible text only, without trailing punctuation or markup', () => {
    expect(extractUrls('<p>See https://example.com/docs.</p><p>and https://example.com/docs</p>')).toEqual([
      'https://example.com/docs',
    ]);
    expect(extractUrls('<p style="x">no links here</p>')).toEqual([]);
  });

  it('createClientId produces ids the server accepts', () => {
    const ids = new Set(Array.from({ length: 50 }, createClientId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('reconcileLatestWindow (T.32, offline changes)', () => {
  type M = { id: string; createdAt: string; content?: string; reactions?: string[] };
  const local: M[] = [
    msg('old', '2026-01-01T00:00:01Z', { content: 'outside the window' }),
    msg('e', '2026-01-01T00:00:05Z', { content: 'before edit' }),
    msg('gone', '2026-01-01T00:00:06Z', { content: 'deleted while offline' }),
    msg('r', '2026-01-01T00:00:07Z', { reactions: ['👍'] }),
    msg(`${PENDING_PREFIX}x`, '2026-01-01T00:00:09Z', { content: 'still sending' }),
  ];
  const page: M[] = [
    msg('e', '2026-01-01T00:00:05Z', { content: 'after edit' }),
    msg('r', '2026-01-01T00:00:07Z', { reactions: [] }),
    msg('new', '2026-01-01T00:00:08Z', { content: 'arrived while offline' }),
  ];

  it('drops messages deleted offline, takes server versions, adds new ones, keeps older history and unsent messages', () => {
    const out = reconcileLatestWindow<M>(local, page);
    expect(out.map((m) => m.id)).toEqual(['old', 'e', 'r', 'new', `${PENDING_PREFIX}x`]);
    expect(out.find((m) => m.id === 'e')?.content).toBe('after edit');
    expect(out.find((m) => m.id === 'r')?.reactions).toEqual([]);
  });

  it('an empty latest page (everything deleted) keeps only unsent messages', () => {
    expect(reconcileLatestWindow<M>(local, []).map((m) => m.id)).toEqual([`${PENDING_PREFIX}x`]);
  });
});
