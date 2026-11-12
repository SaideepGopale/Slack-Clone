import { describe, expect, it } from 'vitest';
import { ReadState } from '../types';
import { applyIncomingMessage, applyReadState, formatUnread, toReadStateMap, unreadCountsOf } from './unread';

const state = (channelId: string, unreadCount: number, lastReadAt: string, lastReadMessageId: string | null = null): ReadState => ({
  channelId,
  unreadCount,
  lastReadAt,
  lastReadMessageId,
});

const base = toReadStateMap([state('c1', 2, '2026-01-01T10:00:00.000Z', 'm1'), state('c2', 0, '2026-01-01T10:00:00.000Z')]);
const msg = (over: Record<string, unknown> = {}) => ({
  id: 'm9',
  channelId: 'c1',
  senderId: 'other',
  createdAt: '2026-01-01T11:00:00.000Z',
  ...over,
});

describe('applyIncomingMessage', () => {
  it('counts a new top-level message from someone else in a background conversation', () => {
    const next = applyIncomingMessage(base, msg(), { currentUserId: 'me', activeChannelId: 'c2', isViewing: true });
    expect(next.c1.unreadCount).toBe(3);
  });

  it('ignores own messages, thread replies, and the conversation being viewed', () => {
    const ctx = { currentUserId: 'me', activeChannelId: 'c2', isViewing: true };
    expect(applyIncomingMessage(base, msg({ senderId: 'me' }), ctx)).toBe(base);
    expect(applyIncomingMessage(base, msg({ parentId: 'p' }), ctx)).toBe(base);
    expect(applyIncomingMessage(base, msg(), { ...ctx, activeChannelId: 'c1' })).toBe(base);
  });

  it('still counts the open conversation while the tab is hidden', () => {
    const next = applyIncomingMessage(base, msg(), { currentUserId: 'me', activeChannelId: 'c1', isViewing: false });
    expect(next.c1.unreadCount).toBe(3);
  });

  it('ignores messages at or before the read position (replayed/backfilled events)', () => {
    expect(applyIncomingMessage(base, msg({ createdAt: '2026-01-01T09:00:00.000Z' }), { isViewing: false })).toBe(base);
  });
});

describe('applyReadState', () => {
  it('applies a newer authoritative state', () => {
    const next = applyReadState(base, state('c1', 0, '2026-01-01T12:00:00.000Z', 'm9'));
    expect(next.c1).toMatchObject({ unreadCount: 0, lastReadMessageId: 'm9' });
  });

  it('never lets an older state overwrite a newer one (out-of-order responses)', () => {
    expect(applyReadState(base, state('c1', 5, '2026-01-01T09:00:00.000Z', 'm0'))).toBe(base);
  });
});

describe('derived values', () => {
  it('exposes non-zero counts and caps the display', () => {
    expect(unreadCountsOf(base)).toEqual({ c1: 2 });
    expect(formatUnread(7)).toBe('7');
    expect(formatUnread(100)).toBe('99+');
  });
});
