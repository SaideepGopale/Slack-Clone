import axios from 'axios';

/**
 * WebRTC ICE servers for calls (T.32, audit H4). The backend decides which
 * STUN/TURN servers to use (GET /api/calls/ice-servers, per-user short-lived
 * TURN credentials when configured); the browser no longer hard-codes them.
 * Loading never blocks a call: until the answer arrives (or if it fails) the
 * public STUN servers are used, and the result is applied to live
 * connections as soon as it is known.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

export interface IceConfig {
  iceServers: RTCIceServer[];
  /** True when a TURN relay is configured (calls work on restrictive networks). */
  relay: boolean;
}

let cached: (IceConfig & { freshUntil: number }) | null = null;
let pending: Promise<IceConfig> | null = null;

export const loadIceConfig = (): Promise<IceConfig> => {
  if (cached && cached.freshUntil > Date.now()) return Promise.resolve(cached);
  if (pending) return pending;
  pending = axios
    .get<{ iceServers: RTCIceServer[]; relay: boolean; ttlSeconds: number }>('/api/calls/ice-servers')
    .then(({ data }) => {
      const servers = Array.isArray(data?.iceServers) && data.iceServers.length ? data.iceServers : DEFAULT_ICE_SERVERS;
      // Refresh before generated TURN credentials expire.
      const ttl = Number(data?.ttlSeconds) > 0 ? Number(data.ttlSeconds) : 3600;
      cached = { iceServers: servers, relay: !!data?.relay, freshUntil: Date.now() + ttl * 800 };
      return cached;
    })
    .catch(() => ({ iceServers: DEFAULT_ICE_SERVERS, relay: false }))
    .finally(() => {
      pending = null;
    });
  return pending;
};

/** The servers to use right now (the loaded ones, or public STUN). */
export const currentIceServers = (): RTCIceServer[] => cached?.iceServers ?? DEFAULT_ICE_SERVERS;

/** Test hook. */
export const resetIceConfig = () => {
  cached = null;
  pending = null;
};
