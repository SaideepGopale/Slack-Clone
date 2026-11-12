import type Redis from 'ioredis';
import { getRedis } from '../lib/redis';

/**
 * Presence state (T.33 — horizontal scaling).
 *
 * Two implementations behind one interface:
 *  - MemoryPresenceStore: one process (no REDIS_URL) — the previous behaviour.
 *  - RedisPresenceStore: shared by every instance. Each socket is a member of
 *    a per-user sorted set scored by its last heartbeat; a user is online
 *    while any socket is fresh. Instances refresh their own sockets every
 *    HEARTBEAT_MS; a sweeper (one instance at a time, Redis lock) removes
 *    users whose sockets all went stale — e.g. their instance crashed without
 *    running disconnect handlers — so nobody stays "online" forever.
 * Connect/disconnect are atomic Lua scripts (single Redis node; Redis Cluster
 * would need hash-tagged keys).
 *
 * Only presence (who is online, their status) is stored — never messages or
 * anything a tenant boundary protects beyond workspace membership ids.
 */
export interface PresenceRecord {
  id: string;
  username: string;
  status: string;
  emoji: string;
}

export interface PresenceStore {
  connect(user: { id: string; username: string; isAdmin: boolean }, socketId: string, workspaceIds: string[]): Promise<{ isNew: boolean }>;
  /** `offline` lists the workspaces the user was visible in when the last socket went away. */
  disconnect(userId: string, socketId: string): Promise<{ offline: false } | { offline: true; workspaceIds: string[] }>;
  setStatus(userId: string, status: string, emoji: string): Promise<{ record: PresenceRecord; workspaceIds: string[] } | null>;
  snapshotFor(userId: string): Promise<PresenceRecord[]>;
  presenceIn(userIds: string[], workspaceId: string): Promise<Map<string, PresenceRecord>>;
  addWorkspace(userId: string, workspaceId: string): Promise<PresenceRecord | null>;
  removeWorkspace(userId: string, workspaceId: string): Promise<{ remaining: string[] } | null>;
  onlineUsersIn(workspaceId: string): Promise<string[]>;
  infoOf(userId: string): Promise<{ isAdmin: boolean; workspaceIds: string[] } | null>;
  onlineCount(): Promise<number>;
  heartbeat(sockets: [userId: string, socketId: string][]): Promise<void>;
  sweep(): Promise<{ userId: string; workspaceIds: string[] }[]>;
}

const STATUS_DEFAULT = { status: 'active', emoji: '🟢' };

// ── Single process ──────────────────────────────────────────────────────────
interface MemoryUser extends PresenceRecord {
  sockets: Set<string>;
  workspaceIds: Set<string>;
  isAdmin: boolean;
}

export class MemoryPresenceStore implements PresenceStore {
  private users = new Map<string, MemoryUser>();

  private record = (u: MemoryUser): PresenceRecord => ({ id: u.id, username: u.username, status: u.status, emoji: u.emoji });

  async connect(user: { id: string; username: string; isAdmin: boolean }, socketId: string, workspaceIds: string[]) {
    let u = this.users.get(user.id);
    const isNew = !u;
    if (!u) {
      u = { id: user.id, username: user.username, ...STATUS_DEFAULT, sockets: new Set(), workspaceIds: new Set(), isAdmin: user.isAdmin };
      this.users.set(user.id, u);
    }
    u.username = user.username;
    u.isAdmin = user.isAdmin;
    u.sockets.add(socketId);
    for (const id of workspaceIds) u.workspaceIds.add(id);
    return { isNew };
  }

  async disconnect(userId: string, socketId: string) {
    const u = this.users.get(userId);
    if (!u) return { offline: false as const };
    u.sockets.delete(socketId);
    if (u.sockets.size > 0) return { offline: false as const };
    this.users.delete(userId);
    return { offline: true as const, workspaceIds: Array.from(u.workspaceIds) };
  }

  async setStatus(userId: string, status: string, emoji: string) {
    const u = this.users.get(userId);
    if (!u) return null;
    u.status = status;
    u.emoji = emoji;
    return { record: this.record(u), workspaceIds: Array.from(u.workspaceIds) };
  }

  async snapshotFor(userId: string) {
    const viewer = this.users.get(userId);
    if (!viewer) return [];
    return Array.from(this.users.values())
      .filter((u) => viewer.isAdmin || u.id === viewer.id || Array.from(u.workspaceIds).some((w) => viewer.workspaceIds.has(w)))
      .map(this.record);
  }

  async presenceIn(userIds: string[], workspaceId: string) {
    const out = new Map<string, PresenceRecord>();
    for (const id of userIds) {
      const u = this.users.get(id);
      if (u && u.workspaceIds.has(workspaceId)) out.set(id, this.record(u));
    }
    return out;
  }

  async addWorkspace(userId: string, workspaceId: string) {
    const u = this.users.get(userId);
    if (!u || u.workspaceIds.has(workspaceId)) return null;
    u.workspaceIds.add(workspaceId);
    return this.record(u);
  }

  async removeWorkspace(userId: string, workspaceId: string) {
    const u = this.users.get(userId);
    if (!u) return null;
    u.workspaceIds.delete(workspaceId);
    return { remaining: Array.from(u.workspaceIds) };
  }

  async onlineUsersIn(workspaceId: string) {
    return Array.from(this.users.values()).filter((u) => u.workspaceIds.has(workspaceId)).map((u) => u.id);
  }

  async infoOf(userId: string) {
    const u = this.users.get(userId);
    return u ? { isAdmin: u.isAdmin, workspaceIds: Array.from(u.workspaceIds) } : null;
  }

  async onlineCount() {
    return this.users.size;
  }

  async heartbeat() {}

  async sweep() {
    return [];
  }
}

// ── Shared (Redis) ──────────────────────────────────────────────────────────
// PRESENCE_HEARTBEAT_MS (0.5–60 s, default 25 s) exists so tests can exercise
// crash recovery quickly; a socket is stale after three missed heartbeats.
export const HEARTBEAT_MS = (() => {
  const n = Number(process.env.PRESENCE_HEARTBEAT_MS);
  return Number.isInteger(n) && n >= 500 && n <= 60_000 ? n : 25_000;
})();
export const STALE_MS = HEARTBEAT_MS * 3;

const K = {
  online: 'pr:online',
  user: (id: string) => `pr:u:${id}`,
  sockets: (id: string) => `pr:s:${id}`,
  userWs: (id: string) => `pr:uw:${id}`,
  ws: (id: string) => `pr:w:${id}`,
  sweepLock: 'pr:sweep-lock',
};

const CONNECT = `
local uid, sid, now = ARGV[1], ARGV[2], ARGV[3]
local isNew = redis.call('SADD', 'pr:online', uid)
redis.call('ZADD', 'pr:s:' .. uid, now, sid)
redis.call('HSET', 'pr:u:' .. uid, 'username', ARGV[4], 'isAdmin', ARGV[5])
if isNew == 1 then redis.call('HSET', 'pr:u:' .. uid, 'status', 'active', 'emoji', ARGV[6]) end
for i = 7, #ARGV do
  redis.call('SADD', 'pr:uw:' .. uid, ARGV[i])
  redis.call('SADD', 'pr:w:' .. ARGV[i], uid)
end
return isNew`;

// Removes a socket (if given) and stale sockets; when none is left, the user
// goes offline atomically. Returns {} while still online, else {'offline', ws...}.
const DISCONNECT = `
local uid, sid, cutoff = ARGV[1], ARGV[2], ARGV[3]
if sid ~= '' then redis.call('ZREM', 'pr:s:' .. uid, sid) end
redis.call('ZREMRANGEBYSCORE', 'pr:s:' .. uid, '-inf', cutoff)
if redis.call('ZCARD', 'pr:s:' .. uid) > 0 then return {} end
if redis.call('SISMEMBER', 'pr:online', uid) == 0 then return {} end
local ws = redis.call('SMEMBERS', 'pr:uw:' .. uid)
for _, w in ipairs(ws) do redis.call('SREM', 'pr:w:' .. w, uid) end
redis.call('SREM', 'pr:online', uid)
redis.call('DEL', 'pr:uw:' .. uid, 'pr:s:' .. uid, 'pr:u:' .. uid)
local out = {'offline'}
for _, w in ipairs(ws) do table.insert(out, w) end
return out`;

export class RedisPresenceStore implements PresenceStore {
  constructor(private readonly redis: Redis) {}

  private async records(ids: string[]): Promise<PresenceRecord[]> {
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hmget(K.user(id), 'username', 'status', 'emoji');
    const rows = (await pipeline.exec()) ?? [];
    const out: PresenceRecord[] = [];
    rows.forEach(([err, value], i) => {
      const [username, status, emoji] = (value as (string | null)[]) ?? [];
      if (!err && username) out.push({ id: ids[i], username, status: status ?? STATUS_DEFAULT.status, emoji: emoji ?? STATUS_DEFAULT.emoji });
    });
    return out;
  }

  async connect(user: { id: string; username: string; isAdmin: boolean }, socketId: string, workspaceIds: string[]) {
    const isNew = (await this.redis.eval(CONNECT, 0, user.id, socketId, String(Date.now()), user.username, user.isAdmin ? '1' : '0', STATUS_DEFAULT.emoji, ...workspaceIds)) as number;
    return { isNew: isNew === 1 };
  }

  async disconnect(userId: string, socketId: string) {
    const result = (await this.redis.eval(DISCONNECT, 0, userId, socketId, String(Date.now() - STALE_MS))) as string[];
    if (!result || result.length === 0) return { offline: false as const };
    return { offline: true as const, workspaceIds: result.slice(1) };
  }

  async setStatus(userId: string, status: string, emoji: string) {
    if (!(await this.redis.sismember(K.online, userId))) return null;
    await this.redis.hset(K.user(userId), 'status', status, 'emoji', emoji);
    const [record] = await this.records([userId]);
    if (!record) return null;
    return { record, workspaceIds: await this.redis.smembers(K.userWs(userId)) };
  }

  async snapshotFor(userId: string) {
    const isAdmin = (await this.redis.hget(K.user(userId), 'isAdmin')) === '1';
    let ids: string[];
    if (isAdmin) {
      ids = await this.redis.smembers(K.online);
    } else {
      const ws = await this.redis.smembers(K.userWs(userId));
      ids = ws.length ? await this.redis.sunion(...ws.map(K.ws)) : [];
      if (!ids.includes(userId) && (await this.redis.sismember(K.online, userId))) ids.push(userId);
    }
    return this.records(ids);
  }

  async presenceIn(userIds: string[], workspaceId: string) {
    const out = new Map<string, PresenceRecord>();
    if (userIds.length === 0) return out;
    const flags = await this.redis.smismember(K.ws(workspaceId), ...userIds);
    const present = userIds.filter((_, i) => flags[i] === 1);
    for (const r of await this.records(present)) out.set(r.id, r);
    return out;
  }

  async addWorkspace(userId: string, workspaceId: string) {
    if (!(await this.redis.sismember(K.online, userId))) return null;
    const added = await this.redis.sadd(K.userWs(userId), workspaceId);
    await this.redis.sadd(K.ws(workspaceId), userId);
    if (added !== 1) return null;
    const [record] = await this.records([userId]);
    return record ?? null;
  }

  async removeWorkspace(userId: string, workspaceId: string) {
    await this.redis.srem(K.ws(workspaceId), userId);
    if (!(await this.redis.sismember(K.online, userId))) return null;
    await this.redis.srem(K.userWs(userId), workspaceId);
    return { remaining: await this.redis.smembers(K.userWs(userId)) };
  }

  async onlineUsersIn(workspaceId: string) {
    return this.redis.smembers(K.ws(workspaceId));
  }

  async infoOf(userId: string) {
    if (!(await this.redis.sismember(K.online, userId))) return null;
    const [isAdmin, workspaceIds] = await Promise.all([this.redis.hget(K.user(userId), 'isAdmin'), this.redis.smembers(K.userWs(userId))]);
    return { isAdmin: isAdmin === '1', workspaceIds };
  }

  async onlineCount() {
    return this.redis.scard(K.online);
  }

  async heartbeat(sockets: [string, string][]) {
    if (sockets.length === 0) return;
    const now = String(Date.now());
    const pipeline = this.redis.pipeline();
    // XX: only refresh sockets that still exist (a disconnected one is not revived).
    for (const [userId, socketId] of sockets) pipeline.zadd(K.sockets(userId), 'XX', now, socketId);
    await pipeline.exec();
  }

  async sweep() {
    const locked = await this.redis.set(K.sweepLock, '1', 'PX', Math.max(200, Math.floor(HEARTBEAT_MS * 0.8)), 'NX');
    if (locked !== 'OK') return [];
    const offline: { userId: string; workspaceIds: string[] }[] = [];
    for (const userId of await this.redis.smembers(K.online)) {
      const result = await this.disconnect(userId, '');
      if (result.offline) offline.push({ userId, workspaceIds: result.workspaceIds });
    }
    return offline;
  }
}

let store: PresenceStore | null = null;
export const getPresenceStore = (): PresenceStore => {
  if (!store) {
    const redis = getRedis();
    store = redis ? new RedisPresenceStore(redis) : new MemoryPresenceStore();
  }
  return store;
};
