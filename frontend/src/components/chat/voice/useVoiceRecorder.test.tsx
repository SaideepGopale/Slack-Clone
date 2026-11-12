import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceRecorder } from './useVoiceRecorder';

/**
 * T.33 — voice recording state machine, with a scripted MediaRecorder and
 * microphone (jsdom has neither). Real timers would make this slow and
 * flaky; fake timers drive the clock.
 */
const recorders: FakeRecorder[] = [];
class FakeRecorder {
  static isTypeSupported = vi.fn((type: string) => type === 'audio/webm;codecs=opus');
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  options: { mimeType?: string } | undefined;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.options = options;
    this.mimeType = options?.mimeType || 'audio/webm';
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice-bytes'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  recorders.length = 0;
  track.stop.mockClear();
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [track] });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  URL.createObjectURL = vi.fn(() => 'blob:voice-preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const started = async () => {
  const hook = renderHook(() => useVoiceRecorder({ maxMs: 60_000 }));
  await act(async () => {
    await hook.result.current.start();
  });
  return hook;
};

describe('useVoiceRecorder (T.33)', () => {
  it('records in the best supported format and counts only unpaused time', async () => {
    const { result } = await started();
    expect(result.current.status).toBe('recording');
    expect(recorders[0].options?.mimeType).toBe('audio/webm;codecs=opus');

    act(() => vi.advanceTimersByTime(1_000));
    act(() => result.current.pause());
    expect(result.current.status).toBe('paused');
    expect(recorders[0].state).toBe('paused');
    act(() => vi.advanceTimersByTime(5_000)); // paused time does not count
    act(() => result.current.resume());
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(1_900);
    expect(result.current.elapsedMs).toBeLessThan(2_500);
  });

  it('stop gives a reviewable recording and releases the microphone', async () => {
    const { result } = await started();
    act(() => vi.advanceTimersByTime(3_000));
    act(() => result.current.stop());
    expect(result.current.status).toBe('review');
    expect(result.current.recording).toMatchObject({ url: 'blob:voice-preview', mimeType: 'audio/webm;codecs=opus', extension: 'webm' });
    expect(result.current.recording!.durationMs).toBeGreaterThanOrEqual(2_900);
    expect(result.current.recording!.blob.size).toBeGreaterThan(0);
    expect(result.current.recording!.peaks).toHaveLength(48);
    expect(track.stop).toHaveBeenCalled();
  });

  it('cancel discards everything, releases the microphone and never produces a recording', async () => {
    const { result } = await started();
    act(() => vi.advanceTimersByTime(2_000));
    act(() => result.current.cancel());
    expect(result.current.status).toBe('idle');
    expect(result.current.recording).toBeNull();
    expect(track.stop).toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('discarding a reviewed recording frees its preview URL', async () => {
    const { result } = await started();
    act(() => result.current.stop());
    act(() => result.current.discard());
    expect(result.current.status).toBe('idle');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-preview');
  });

  it('stops by itself at the length limit', async () => {
    const { result } = await started();
    act(() => vi.advanceTimersByTime(61_000));
    expect(result.current.status).toBe('review');
    expect(result.current.recording!.durationMs).toBeLessThanOrEqual(61_000);
  });

  it('explains a blocked microphone', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/blocked/i);
  });

  it('reports browsers without recording support', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/not supported/i);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('releases the microphone if the component goes away mid-recording', async () => {
    const { unmount } = await started();
    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
