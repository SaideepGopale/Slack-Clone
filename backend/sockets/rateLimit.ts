import { getRedis } from '../lib/redis';
import { AuthenticatedSocket } from './types';

/**
 * Per-user Socket.IO event rate limits (T.32, audit M5). Before this, no socket
 * event was throttled: any member could ring a whole channel in a loop
 * (`call:initiate`), flood `message:send` (≈6 queries + fan-out each) or spam
 * typing and signalling events.
 *
 * Fixed windows keyed by user id + event (so opening more tabs does not
 * multiply the budget). Budgets are far above human use. An over-limit event
 * is dropped before any handler runs; if the client asked for an
 * acknowledgement it receives `{ ok: false, error: 'rate_limited' }` so its UI
 * can recover instead of waiting forever.
 *
 * State is in process memory, like the rest of the real-time layer: with
 * several instances each would enforce its own budget (see T.32 — horizontal
 * scaling needs a shared store such as Redis).
 *
 * Skipped when NODE_ENV=test, matching the HTTP limiters; tests switch it on
 * explicitly.
 */
export const SOCKET_EVENT_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  'message:send': { limit: 30, windowMs: 10_000 },
  'message:edit': { limit: 30, windowMs: 10_000 },
  'message:delete': { limit: 30, windowMs: 10_000 },
  'message:pin': { limit: 20, windowMs: 10_000 },
  'poll:vote': { limit: 20, windowMs: 10_000 },
  'typing:start': { limit: 40, windowMs: 10_000 },
  'typing:stop': { limit: 40, windowMs: 10_000 },
  'channel:join': { limit: 120, windowMs: 60_000 },
  'thread:join': { limit: 120, windowMs: 60_000 },
  'thread:leave': { limit: 120, windowMs: 60_000 },
  'user:status': { limit: 30, windowMs: 60_000 },
  'call:initiate': { limit: 6, windowMs: 60_000 },
  'call:decline': { limit: 30, windowMs: 60_000 },
  'call:cancel': { limit: 30, windowMs: 60_000 },
  'webrtc:join': { limit: 30, windowMs: 60_000 },
  'webrtc:leave': { limit: 60, windowMs: 60_000 },
  'webrtc:offer': { limit: 240, windowMs: 60_000 },
  'webrtc:answer': { limit: 240, windowMs: 60_000 },
  'webrtc:media-state': { limit: 60, windowMs: 60_000 },
  'webrtc:ice-candidate': { limit: 1200, windowMs: 60_000 },
  'admin:channel:deleted': { limit: 30, windowMs: 60_000 },
  'admin:user:kick': { limit: 30, windowMs: 60_000 },
  'admin:refresh:channels': { limit: 30, windowMs: 60_000 },
};
// Any event not listed above (unknown to the server) gets this budget.
const DEFAULT_LIMIT = { limit: 60, windowMs: 10_000 };

const windows = new Map<string, { count: number; resetAt: number }>();

// Drop expired windows now and then so the map cannot grow without bound.
let lastSweep = Date.now();
const sweep = (now: number) => {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, entry] of windows) if (entry.resetAt <= now) windows.delete(key);
};

/** True when this event is within budget (and counts it). */
export const takeSocketEventBudget = (userId: string, event: string, now = Date.now()): boolean => {
  const { limit, windowMs } = SOCKET_EVENT_LIMITS[event] ?? DEFAULT_LIMIT;
  sweep(now);
  const key = `${userId}\u0000${event}`;
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
};

/** Test hook: forget every window. */
export const resetSocketRateLimits = () => windows.clear();

// T.33: with REDIS_URL set, the same windows are counted in Redis (one
// budget per user across every instance). One atomic script per event:
// INCR, and start the window on the first hit.
const REDIS_WINDOW_SCRIPT = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return c";

export const takeSocketEventBudgetShared = async (userId: string, event: string): Promise<boolean> => {
  const client = getRedis();
  if (!client) return takeSocketEventBudget(userId, event);
  const { limit, windowMs } = SOCKET_EVENT_LIMITS[event] ?? DEFAULT_LIMIT;
  const count = (await client.eval(REDIS_WINDOW_SCRIPT, 1, `rl:sock:${event}:${userId}`, String(windowMs))) as number;
  return count <= limit;
};

/** Installs the per-event limiter on one connection (before its handlers run). */
export const installSocketRateLimit = (socket: AuthenticatedSocket) => {
  socket.use((packet, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const event = typeof packet[0] === 'string' ? packet[0] : '';
    const refuse = () => {
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') ack({ ok: false, error: 'rate_limited', message: 'You are doing that too often. Please wait a moment.' });
      // Dropped: the handler never runs. (Not passed to next(err), which would
      // only surface as a server-side 'error' event.)
    };
    takeSocketEventBudgetShared(socket.user.id, event).then(
      (ok) => (ok ? next() : refuse()),
      // Fail open: a Redis outage must not freeze real-time for everyone.
      () => next()
    );
  });
};
