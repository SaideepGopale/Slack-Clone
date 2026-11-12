import { act, renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { useConnectionStatus } from './useSocket';

type Listener = (...args: unknown[]) => void;

// Tiny emitter so the test doesn't depend on Node's `events` types (the
// frontend tsconfig only loads browser/Vite types).
class MiniEmitter {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  off(event: string, fn: Listener) {
    this.listeners.get(event)?.delete(fn);
  }
  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
}

// Minimal stand-in exposing the subset of the Socket API the hook uses.
const fakeSocket = () => {
  const emitter = new MiniEmitter();
  const manager = new MiniEmitter();
  const socket = {
    connected: false,
    on: (e: string, fn: (...a: unknown[]) => void) => emitter.on(e, fn),
    off: (e: string, fn: (...a: unknown[]) => void) => emitter.off(e, fn),
    io: { on: (e: string, fn: () => void) => manager.on(e, fn), off: (e: string, fn: () => void) => manager.off(e, fn) },
  };
  return {
    socket: socket as unknown as Socket,
    connect: () => {
      socket.connected = true;
      emitter.emit('connect');
    },
    drop: () => {
      socket.connected = false;
      emitter.emit('disconnect', 'transport close');
    },
  };
};

describe('useConnectionStatus', () => {
  it('moves connecting -> connected -> reconnecting -> connected', () => {
    const fake = fakeSocket();
    const { result } = renderHook(() => useConnectionStatus(fake.socket));
    expect(result.current).toBe('connecting');
    act(() => fake.connect());
    expect(result.current).toBe('connected');
    act(() => fake.drop());
    expect(result.current).toBe('reconnecting');
    act(() => fake.connect());
    expect(result.current).toBe('connected');
  });
});
