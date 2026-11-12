import type Redis from 'ioredis';
import { getRedis } from '../lib/redis';

/**
 * Call state (T.33 — horizontal scaling): who is in which call, and the one
 * active ring per conversation.
 *
 * MemoryCallStore keeps the previous single-process behaviour. RedisCallStore
 * shares it between instances so two people connected to different instances
 * can be in the same call, a call cap is enforced globally, and a ring
 * started on one instance can be declined/answered/cancelled from another.
 * Every check-and-set is a single Lua script (atomic on one Redis node).
 *
 * Only signalling metadata is stored (socket ids, user ids, display names,
 * mic/camera flags) — never media or message content.
 */
export interface CallParticipant {
  socketId: string;
  userId: string;
  username: string;
  media: { audio: boolean; video: boolean };
  joinedAt: number;
}

export interface CallRing {
  ringId: string;
  callerId: string;
  callerSocketId: string;
  oneToOne: boolean;
  answered: boolean;
}

export type JoinResult = { ok: false; full: true } | { ok: true; rejoin: boolean; others: CallParticipant[] };

export interface CallStore {
  join(channelId: string, participant: CallParticipant, max: number): Promise<JoinResult>;
  get(channelId: string, socketId: string): Promise<CallParticipant | null>;
  participants(channelId: string): Promise<CallParticipant[]>;
  /** true when the socket was a participant. */
  leave(channelId: string, socketId: string): Promise<boolean>;
  channelsOf(socketId: string): Promise<string[]>;
  setMedia(channelId: string, socketId: string, media: { audio: boolean; video: boolean }): Promise<void>;
  /** Removes participants older than `graceMs` whose socket is not in `liveSocketIds`. */
  prune(channelId: string, liveSocketIds: Set<string>, graceMs: number): Promise<string[]>;
  /** Sets the ring unless another caller's ring is active; returns the ring in force. */
  startRing(channelId: string, ring: CallRing, ttlMs: number): Promise<CallRing>;
  getRing(channelId: string): Promise<CallRing | null>;
  /** Atomically removes and returns the ring (only that ring when `ringId` is given). */
  takeRing(channelId: string, ringId?: string): Promise<CallRing | null>;
  /** Someone other than the caller joined: marks the ring answered and returns it. */
  markAnswered(channelId: string, userId: string): Promise<CallRing | null>;
}

// ── Single process ──────────────────────────────────────────────────────────
export class MemoryCallStore implements CallStore {
  private rooms = new Map<string, Map<string, CallParticipant>>();
  private rings = new Map<string, CallRing>();

  async join(channelId: string, participant: CallParticipant, max: number): Promise<JoinResult> {
    const room = this.rooms.get(channelId) ?? new Map<string, CallParticipant>();
    const rejoin = room.has(participant.socketId);
    if (!rejoin && room.size >= max) return { ok: false, full: true };
    const others = Array.from(room.values()).filter((p) => p.socketId !== participant.socketId);
    room.set(participant.socketId, participant);
    this.rooms.set(channelId, room);
    return { ok: true, rejoin, others };
  }

  async get(channelId: string, socketId: string) {
    return this.rooms.get(channelId)?.get(socketId) ?? null;
  }

  async participants(channelId: string) {
    return Array.from(this.rooms.get(channelId)?.values() ?? []);
  }

  async leave(channelId: string, socketId: string) {
    const room = this.rooms.get(channelId);
    if (!room?.delete(socketId)) return false;
    if (room.size === 0) this.rooms.delete(channelId);
    return true;
  }

  async channelsOf(socketId: string) {
    return Array.from(this.rooms.entries())
      .filter(([, room]) => room.has(socketId))
      .map(([channelId]) => channelId);
  }

  async setMedia(channelId: string, socketId: string, media: { audio: boolean; video: boolean }) {
    const p = this.rooms.get(channelId)?.get(socketId);
    if (p) p.media = media;
  }

  async prune(channelId: string, liveSocketIds: Set<string>, graceMs: number) {
    const cutoff = Date.now() - graceMs;
    const removed: string[] = [];
    for (const p of await this.participants(channelId)) {
      if (p.joinedAt < cutoff && !liveSocketIds.has(p.socketId)) {
        await this.leave(channelId, p.socketId);
        removed.push(p.socketId);
      }
    }
    return removed;
  }

  async startRing(channelId: string, ring: CallRing) {
    const existing = this.rings.get(channelId);
    if (existing && existing.callerId !== ring.callerId) return existing;
    this.rings.set(channelId, ring);
    return ring;
  }

  async getRing(channelId: string) {
    return this.rings.get(channelId) ?? null;
  }

  async takeRing(channelId: string, ringId?: string) {
    const ring = this.rings.get(channelId);
    if (!ring || (ringId && ring.ringId !== ringId)) return null;
    this.rings.delete(channelId);
    return ring;
  }

  async markAnswered(channelId: string, userId: string) {
    const ring = this.rings.get(channelId);
    if (!ring || ring.callerId === userId) return null;
    ring.answered = true;
    return ring;
  }
}

// ── Shared (Redis) ──────────────────────────────────────────────────────────
// Backstop expiry: entries are removed on leave/disconnect, and stale ones
// (instance crash) are pruned on the next join; this only bounds leftovers.
const ROOM_TTL_S = 24 * 60 * 60;

const JOIN = `
local key, sid = 'call:p:' .. ARGV[1], ARGV[2]
local rejoin = redis.call('HEXISTS', key, sid)
if rejoin == 0 and redis.call('HLEN', key) >= tonumber(ARGV[4]) then return {-1} end
local out = {rejoin}
local all = redis.call('HGETALL', key)
for i = 1, #all, 2 do
  if all[i] ~= sid then table.insert(out, all[i + 1]) end
end
redis.call('HSET', key, sid, ARGV[3])
redis.call('EXPIRE', key, ARGV[5])
redis.call('SADD', 'call:s:' .. sid, ARGV[1])
redis.call('EXPIRE', 'call:s:' .. sid, ARGV[5])
return out`;

const LEAVE = `
local removed = redis.call('HDEL', 'call:p:' .. ARGV[1], ARGV[2])
redis.call('SREM', 'call:s:' .. ARGV[2], ARGV[1])
return removed`;

const SET_MEDIA = `
local cur = redis.call('HGET', 'call:p:' .. ARGV[1], ARGV[2])
if not cur then return 0 end
local p = cjson.decode(cur)
p.media = { audio = ARGV[3] == '1', video = ARGV[4] == '1' }
redis.call('HSET', 'call:p:' .. ARGV[1], ARGV[2], cjson.encode(p))
return 1`;

const START_RING = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local c = cjson.decode(cur)
  if c.callerId ~= ARGV[2] then return cur end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
return ARGV[1]`;

const TAKE_RING = `
local cur = redis.call('GET', KEYS[1])
if not cur then return false end
if ARGV[1] ~= '' and cjson.decode(cur).ringId ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return cur`;

const MARK_ANSWERED = `
local cur = redis.call('GET', KEYS[1])
if not cur then return false end
local r = cjson.decode(cur)
if r.callerId == ARGV[1] then return false end
r.answered = true
local enc = cjson.encode(r)
redis.call('SET', KEYS[1], enc, 'KEEPTTL')
return enc`;

const parse = <T>(value: string | null | undefined): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const ringKey = (channelId: string) => `call:ring:${channelId}`;

export class RedisCallStore implements CallStore {
  constructor(private readonly redis: Redis) {}

  async join(channelId: string, participant: CallParticipant, max: number): Promise<JoinResult> {
    const out = (await this.redis.eval(JOIN, 0, channelId, participant.socketId, JSON.stringify(participant), String(max), String(ROOM_TTL_S))) as [
      number,
      ...string[],
    ];
    if (out[0] === -1) return { ok: false, full: true };
    const others = out.slice(1).map((v) => parse<CallParticipant>(v as string)).filter((p): p is CallParticipant => !!p);
    return { ok: true, rejoin: out[0] === 1, others };
  }

  async get(channelId: string, socketId: string) {
    return parse<CallParticipant>(await this.redis.hget(`call:p:${channelId}`, socketId));
  }

  async participants(channelId: string) {
    const all = await this.redis.hvals(`call:p:${channelId}`);
    return all.map((v) => parse<CallParticipant>(v)).filter((p): p is CallParticipant => !!p);
  }

  async leave(channelId: string, socketId: string) {
    return ((await this.redis.eval(LEAVE, 0, channelId, socketId)) as number) === 1;
  }

  async channelsOf(socketId: string) {
    return this.redis.smembers(`call:s:${socketId}`);
  }

  async setMedia(channelId: string, socketId: string, media: { audio: boolean; video: boolean }) {
    await this.redis.eval(SET_MEDIA, 0, channelId, socketId, media.audio ? '1' : '0', media.video ? '1' : '0');
  }

  async prune(channelId: string, liveSocketIds: Set<string>, graceMs: number) {
    const cutoff = Date.now() - graceMs;
    const removed: string[] = [];
    for (const p of await this.participants(channelId)) {
      if (p.joinedAt < cutoff && !liveSocketIds.has(p.socketId) && (await this.leave(channelId, p.socketId))) removed.push(p.socketId);
    }
    return removed;
  }

  async startRing(channelId: string, ring: CallRing, ttlMs: number) {
    const value = (await this.redis.eval(START_RING, 1, ringKey(channelId), JSON.stringify(ring), ring.callerId, String(ttlMs))) as string;
    return parse<CallRing>(value) ?? ring;
  }

  async getRing(channelId: string) {
    return parse<CallRing>(await this.redis.get(ringKey(channelId)));
  }

  async takeRing(channelId: string, ringId?: string) {
    return parse<CallRing>((await this.redis.eval(TAKE_RING, 1, ringKey(channelId), ringId ?? '')) as string | null);
  }

  async markAnswered(channelId: string, userId: string) {
    return parse<CallRing>((await this.redis.eval(MARK_ANSWERED, 1, ringKey(channelId), userId)) as string | null);
  }
}

let store: CallStore | null = null;
export const getCallStore = (): CallStore => {
  if (!store) {
    const redis = getRedis();
    store = redis ? new RedisCallStore(redis) : new MemoryCallStore();
  }
  return store;
};
