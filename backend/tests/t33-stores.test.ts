import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CallParticipant, CallStore, MemoryCallStore, RedisCallStore } from '../sockets/callStore';
import { MemoryPresenceStore, PresenceStore, RedisPresenceStore, STALE_MS } from '../sockets/presenceStore';

/**
 * T.33 — the shared state behind horizontal scaling. The same contract runs
 * against the in-memory stores (one instance) and the Redis stores (many
 * instances). The Redis half needs TEST_REDIS_URL pointing at a DISPOSABLE
 * local Redis (its database is flushed); it is skipped otherwise.
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const isLocal = (url: string) => /^redis:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\d+$/.test(url);

let redis: Redis | null = null;
beforeAll(async () => {
  if (!TEST_REDIS_URL) return;
  if (!isLocal(TEST_REDIS_URL)) throw new Error('TEST_REDIS_URL must be a local redis://127.0.0.1:<port>/<db> — this test flushes it.');
  redis = new Redis(TEST_REDIS_URL);
});
afterAll(async () => {
  await redis?.quit();
});

const ALICE = { id: 'u-alice', username: 'alice', isAdmin: false };
const BOB = { id: 'u-bob', username: 'bob', isAdmin: false };
const CAROL = { id: 'u-carol', username: 'carol', isAdmin: false };
const ADMIN = { id: 'u-admin', username: 'root', isAdmin: true };

const presenceContract = (name: string, make: () => PresenceStore, enabled: boolean) =>
  describe.skipIf(!enabled)(`${name} presence store`, () => {
    let store: PresenceStore;
    beforeEach(async () => {
      await redis?.flushdb();
      store = make();
    });

    it('is online while any socket remains and reports the workspaces on the last disconnect', async () => {
      expect((await store.connect(ALICE, 's1', ['w1'])).isNew).toBe(true);
      expect((await store.connect(ALICE, 's2', ['w1', 'w2'])).isNew).toBe(false);
      expect(await store.onlineCount()).toBe(1);
      expect(await store.disconnect(ALICE.id, 's1')).toEqual({ offline: false });
      const last = await store.disconnect(ALICE.id, 's2');
      expect(last.offline).toBe(true);
      expect(last.offline && last.workspaceIds.sort()).toEqual(['w1', 'w2']);
      expect(await store.onlineCount()).toBe(0);
      // A second disconnect is a no-op, not a second "offline".
      expect(await store.disconnect(ALICE.id, 's2')).toEqual({ offline: false });
    });

    it('scopes snapshots to shared workspaces; platform admins see everyone', async () => {
      await store.connect(ALICE, 'a', ['w1']);
      await store.connect(BOB, 'b', ['w1', 'w2']);
      await store.connect(CAROL, 'c', ['w3']);
      await store.connect(ADMIN, 'x', []);
      const ids = async (userId: string) => (await store.snapshotFor(userId)).map((u) => u.id).sort();
      expect(await ids(ALICE.id)).toEqual([ALICE.id, BOB.id].sort());
      expect(await ids(CAROL.id)).toEqual([CAROL.id]);
      expect(await ids(ADMIN.id)).toEqual([ADMIN.id, ALICE.id, BOB.id, CAROL.id].sort());
    });

    it('answers presence for a batch of users inside one workspace only', async () => {
      await store.connect(ALICE, 'a', ['w1']);
      await store.connect(BOB, 'b', ['w2']);
      const map = await store.presenceIn([ALICE.id, BOB.id, 'nobody'], 'w1');
      expect(Array.from(map.keys())).toEqual([ALICE.id]);
      expect(map.get(ALICE.id)).toEqual({ id: ALICE.id, username: 'alice', status: 'active', emoji: '🟢' });
    });

    it('updates status and adds/removes workspaces at runtime', async () => {
      await store.connect(ALICE, 'a', ['w1']);
      const changed = await store.setStatus(ALICE.id, 'away', '🟡');
      expect(changed?.record.status).toBe('away');
      expect(await store.setStatus(BOB.id, 'away', '🟡')).toBeNull(); // offline user
      expect((await store.addWorkspace(ALICE.id, 'w2'))?.id).toBe(ALICE.id);
      expect(await store.addWorkspace(ALICE.id, 'w2')).toBeNull(); // already there
      expect((await store.onlineUsersIn('w2')).sort()).toEqual([ALICE.id]);
      expect(await store.removeWorkspace(ALICE.id, 'w1')).toEqual({ remaining: ['w2'] });
      expect(await store.onlineUsersIn('w1')).toEqual([]);
      expect(await store.infoOf(ALICE.id)).toEqual({ isAdmin: false, workspaceIds: ['w2'] });
    });
  });

presenceContract('memory', () => new MemoryPresenceStore(), true);
presenceContract('redis', () => new RedisPresenceStore(redis!), !!TEST_REDIS_URL);

describe.skipIf(!TEST_REDIS_URL)('redis presence: crash recovery', () => {
  beforeEach(async () => {
    await redis!.flushdb();
  });

  it('a user whose sockets stopped heart-beating (instance died) is swept offline exactly once', async () => {
    const store = new RedisPresenceStore(redis!);
    await store.connect(ALICE, 'dead-socket', ['w1']);
    await store.connect(BOB, 'live-socket', ['w1']);
    // Simulate the dead instance: its socket's last heartbeat is older than the stale window.
    await redis!.zadd(`pr:s:${ALICE.id}`, String(Date.now() - STALE_MS - 1_000), 'dead-socket');
    await store.heartbeat([[BOB.id, 'live-socket']]);

    expect(await store.sweep()).toEqual([{ userId: ALICE.id, workspaceIds: ['w1'] }]);
    expect(await store.onlineUsersIn('w1')).toEqual([BOB.id]);
    // The sweep lock keeps a second instance from sweeping in the same period.
    expect(await store.sweep()).toEqual([]);
  });

  it('a heartbeat never revives a socket that already disconnected', async () => {
    const store = new RedisPresenceStore(redis!);
    await store.connect(ALICE, 's1', ['w1']);
    await store.disconnect(ALICE.id, 's1');
    await store.heartbeat([[ALICE.id, 's1']]);
    expect(await store.onlineCount()).toBe(0);
    expect(await redis!.exists(`pr:s:${ALICE.id}`)).toBe(0);
  });
});

const participant = (socketId: string, userId = `user-${socketId}`): CallParticipant => ({
  socketId,
  userId,
  username: userId,
  media: { audio: true, video: false },
  joinedAt: Date.now(),
});

const callContract = (name: string, make: () => CallStore, enabled: boolean) =>
  describe.skipIf(!enabled)(`${name} call store`, () => {
    let store: CallStore;
    beforeEach(async () => {
      await redis?.flushdb();
      store = make();
    });

    it('enforces the participant cap atomically under concurrent joins', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.join('ch', participant(`s${i}`), 8)));
      expect(results.filter((r) => r.ok)).toHaveLength(8);
      expect(results.filter((r) => !r.ok)).toHaveLength(4);
      expect(await store.participants('ch')).toHaveLength(8);
    });

    it('lists the others on join, treats a repeated join as a rejoin, and cleans up on leave', async () => {
      await store.join('ch', participant('a'), 8);
      const second = await store.join('ch', participant('b'), 8);
      expect(second.ok && second.others.map((p) => p.socketId)).toEqual(['a']);
      const again = await store.join('ch', participant('b'), 8);
      expect(again.ok && again.rejoin).toBe(true);
      expect(again.ok && again.others.map((p) => p.socketId)).toEqual(['a']);
      expect(await store.channelsOf('b')).toEqual(['ch']);
      await store.setMedia('ch', 'b', { audio: false, video: true });
      expect((await store.get('ch', 'b'))?.media).toEqual({ audio: false, video: true });
      expect(await store.leave('ch', 'b')).toBe(true);
      expect(await store.leave('ch', 'b')).toBe(false);
      expect(await store.get('ch', 'b')).toBeNull();
      expect(await store.channelsOf('b')).toEqual([]);
    });

    it('prunes only participants past the grace period whose socket is gone', async () => {
      await store.join('ch', { ...participant('old-dead'), joinedAt: Date.now() - 60_000 }, 8);
      await store.join('ch', { ...participant('old-live'), joinedAt: Date.now() - 60_000 }, 8);
      await store.join('ch', participant('new-not-yet-in-room'), 8);
      expect(await store.prune('ch', new Set(['old-live']), 30_000)).toEqual(['old-dead']);
      expect((await store.participants('ch')).map((p) => p.socketId).sort()).toEqual(['new-not-yet-in-room', 'old-live']);
    });

    it('keeps one ring per conversation: another caller cannot replace it, ends are compare-and-delete', async () => {
      const first = { ringId: 'r1', callerId: 'alice', callerSocketId: 'sa', oneToOne: true, answered: false };
      expect((await store.startRing('ch', first, 10_000)).ringId).toBe('r1');
      const intruder = { ...first, ringId: 'r2', callerId: 'bob', callerSocketId: 'sb' };
      expect((await store.startRing('ch', intruder, 10_000)).ringId).toBe('r1');
      const rering = { ...first, ringId: 'r3' };
      expect((await store.startRing('ch', rering, 10_000)).ringId).toBe('r3'); // same caller restarts

      expect(await store.markAnswered('ch', 'alice')).toBeNull(); // the caller "joining" is not an answer
      expect((await store.markAnswered('ch', 'bob'))?.answered).toBe(true);
      expect(await store.takeRing('ch', 'r1')).toBeNull(); // an old timer cannot end the new ring
      expect((await store.takeRing('ch', 'r3'))?.answered).toBe(true);
      expect(await store.getRing('ch')).toBeNull();
    });
  });

callContract('memory', () => new MemoryCallStore(), true);
callContract('redis', () => new RedisCallStore(redis!), !!TEST_REDIS_URL);

describe.skipIf(!TEST_REDIS_URL)('redis call store: expiry', () => {
  it('a ring expires on its own if the instance that owns its timer dies', async () => {
    await redis!.flushdb();
    const store = new RedisCallStore(redis!);
    await store.startRing('ch', { ringId: 'r', callerId: 'a', callerSocketId: 's', oneToOne: false, answered: false }, 150);
    expect(await store.getRing('ch')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await store.getRing('ch')).toBeNull();
  });
});
