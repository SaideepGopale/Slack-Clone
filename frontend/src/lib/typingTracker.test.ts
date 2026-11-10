import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTypingTracker, TYPING_TTL_MS } from './typingTracker';

describe('typing tracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('forgets someone who stops sending typing events (e.g. closed the tab)', () => {
    const seen: string[][] = [];
    const tracker = createTypingTracker((names) => seen.push(names));
    tracker.start('ana');
    expect(seen.at(-1)).toEqual(['ana']);
    vi.advanceTimersByTime(TYPING_TTL_MS - 1);
    expect(seen.at(-1)).toEqual(['ana']);
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)).toEqual([]);
  });

  it('keeps someone listed while their typing events keep arriving', () => {
    const seen: string[][] = [];
    const tracker = createTypingTracker((names) => seen.push(names));
    tracker.start('ana');
    vi.advanceTimersByTime(TYPING_TTL_MS - 500);
    tracker.start('ana');
    vi.advanceTimersByTime(TYPING_TTL_MS - 500);
    expect(seen.at(-1)).toEqual(['ana']);
    // A repeat start for someone already listed doesn't re-render.
    expect(seen).toHaveLength(1);
  });

  it('removes on an explicit stop, and clear() forgets everyone and cancels timers', () => {
    const seen: string[][] = [];
    const tracker = createTypingTracker((names) => seen.push(names));
    tracker.start('ana');
    tracker.start('ben');
    tracker.stop('ana');
    expect(seen.at(-1)).toEqual(['ben']);
    tracker.stop('nobody');
    expect(seen).toHaveLength(3);
    tracker.clear();
    expect(seen.at(-1)).toEqual([]);
    vi.advanceTimersByTime(TYPING_TTL_MS * 2);
    expect(seen).toHaveLength(4);
  });
});
