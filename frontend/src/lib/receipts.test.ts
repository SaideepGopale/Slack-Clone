import { describe, expect, it } from 'vitest';
import { hasRead, seenBy, seenLabel, upsertReceipt } from './receipts';

const message = { id: 'b', createdAt: '2026-01-01T10:00:00.000Z' };
const receipt = (userId: string, lastReadAt: string | null, lastReadMessageId: string | null = null) => ({
  userId,
  username: userId,
  lastReadAt,
  lastReadMessageId,
});

describe('read receipts', () => {
  it('treats a pointer at or after the message as read (ties broken by id)', () => {
    expect(hasRead(receipt('ann', '2026-01-01T11:00:00.000Z'), message)).toBe(true);
    expect(hasRead(receipt('ann', '2026-01-01T10:00:00.000Z', 'b'), message)).toBe(true);
    expect(hasRead(receipt('ann', '2026-01-01T10:00:00.000Z', 'a'), message)).toBe(false);
    expect(hasRead(receipt('ann', '2026-01-01T09:00:00.000Z', 'z'), message)).toBe(false);
    expect(hasRead(receipt('ann', null), message)).toBe(false);
  });

  it('labels 1:1 and group conversations', () => {
    const rs = [receipt('ann', '2026-01-02T00:00:00.000Z'), receipt('bob', '2026-01-02T00:00:00.000Z'), receipt('cy', null)];
    const names = seenBy(rs, message);
    expect(names).toEqual(['ann', 'bob']);
    expect(seenLabel(names, false)).toBe('Seen');
    expect(seenLabel(names, true)).toBe('Seen by ann, bob');
    expect(seenLabel(['a', 'b', 'c', 'd', 'e'], true)).toBe('Seen by a, b, c +2');
    expect(seenLabel([], true)).toBeNull();
    expect(seenBy(rs, undefined)).toEqual([]);
  });

  it('keeps one receipt per participant and never moves it backwards', () => {
    const start = [receipt('ann', '2026-01-02T00:00:00.000Z')];
    expect(upsertReceipt(start, receipt('ann', '2026-01-01T00:00:00.000Z'))).toBe(start);
    const next = upsertReceipt(start, receipt('ann', '2026-01-03T00:00:00.000Z'));
    expect(next).toHaveLength(1);
    expect(next[0].lastReadAt).toBe('2026-01-03T00:00:00.000Z');
  });
});
