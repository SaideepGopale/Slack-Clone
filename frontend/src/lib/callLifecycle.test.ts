import { describe, expect, it } from 'vitest';
import { formatCallDuration, parseCallDeclined, parseRingEnded } from './callSignalling';

describe('call lifecycle payloads (P2 Phase H)', () => {
  it('accepts well-formed ring-ended events only', () => {
    expect(parseRingEnded({ channelId: 'c1', reason: 'timeout' })).toEqual({ channelId: 'c1', reason: 'timeout' });
    for (const reason of ['cancelled', 'declined', 'answered']) {
      expect(parseRingEnded({ channelId: 'c1', reason })?.reason).toBe(reason);
    }
    expect(parseRingEnded({ channelId: 'c1', reason: 'boom' })).toBeNull();
    expect(parseRingEnded({ reason: 'timeout' })).toBeNull();
    expect(parseRingEnded(null)).toBeNull();
    expect(parseRingEnded({ channelId: 'x'.repeat(200), reason: 'timeout' })).toBeNull();
  });

  it('accepts decline notices with a bounded, non-empty name', () => {
    expect(parseCallDeclined({ channelId: 'c1', userId: 'u2', username: 'bob' })).toEqual({ channelId: 'c1', userId: 'u2', username: 'bob' });
    expect(parseCallDeclined({ channelId: 'c1', userId: 'u2', username: { evil: true } })?.username).toBe('Someone');
    expect(parseCallDeclined({ channelId: 'c1', username: 'bob' })).toBeNull();
    expect(parseCallDeclined('nope')).toBeNull();
  });

  it('formats call durations as m:ss, or h:mm:ss past an hour', () => {
    expect(formatCallDuration(0)).toBe('0:00');
    expect(formatCallDuration(65_000)).toBe('1:05');
    expect(formatCallDuration(3_600_000 + 61_000)).toBe('1:01:01');
    expect(formatCallDuration(-5)).toBe('0:00');
  });
});
