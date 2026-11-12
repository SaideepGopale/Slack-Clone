import { ChildProcess, spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import Redis from 'ioredis';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { io as ioClient, Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addToWorkspace, createDM, createWorkspace, TestUser } from './collab-helpers';
import { createAndLoginUser } from './helpers';
import { collect, emitAck, nextEvent } from './socket-harness';

/**
 * T.33 — horizontal scaling, proven with real processes: two (and briefly
 * three) separate `server.ts` instances share the test database and one
 * Redis, exactly like two instances behind a load balancer. Clients are
 * deliberately connected to DIFFERENT instances; every assertion below would
 * fail with the in-memory adapter/stores, where each instance only knows its
 * own sockets.
 *
 * Needs TEST_REDIS_URL (a disposable local Redis; its database is flushed)
 * and the usual disposable DATABASE_URL. Skipped without TEST_REDIS_URL.
 * The instances run in an empty temporary directory, so no `.env` file is
 * loaded into them — every setting they get is the dummy/test value below.
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url));

interface Instance {
  name: string;
  url: string;
  proc: ChildProcess;
  output: string[];
  exited: Promise<number | null>;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let workDir = '';
const startInstance = async (name: string): Promise<Instance> => {
  const port = await freePort();
  // One node process with the tsx loader (not the `tsx` CLI, which runs the
  // server in a child process — a SIGKILL would then only kill the wrapper).
  const loader = pathToFileURL(join(BACKEND_DIR, 'node_modules/tsx/dist/loader.mjs')).href;
  const proc = spawn(process.execPath, ['--import', loader, join(BACKEND_DIR, 'server.ts')], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'development', // limiters ON (they are skipped under NODE_ENV=test)
      PORT: String(port),
      DATABASE_URL: process.env.DATABASE_URL,
      JWT_SECRET: process.env.JWT_SECRET, // the test suite's value, so test tokens are valid
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
      REDIS_URL: TEST_REDIS_URL,
      PRESENCE_HEARTBEAT_MS: '1000', // stale after 3 s, so crash recovery is testable
      CALL_MAX_PARTICIPANTS: '2',
      CALL_RING_TIMEOUT_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  const keep = (chunk: Buffer) => {
    output.push(chunk.toString());
    if (output.length > 400) output.splice(0, output.length - 400);
  };
  proc.stdout!.on('data', keep);
  proc.stderr!.on('data', keep);
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/ready`);
      if (res.status === 200) return { name, url, proc, output, exited };
    } catch {
      // not listening yet
    }
    if (proc.exitCode !== null) break;
    await sleep(250);
  }
  proc.kill('SIGKILL');
  throw new Error(`instance ${name} did not become ready:\n${output.join('').slice(-3000)}`);
};

const stopInstance = async (instance: Instance | undefined) => {
  if (!instance || instance.proc.exitCode !== null) return;
  instance.proc.kill('SIGTERM');
  await Promise.race([instance.exited, sleep(20_000)]);
  if (instance.proc.exitCode === null) instance.proc.kill('SIGKILL');
};

const sockets: Socket[] = [];
/** Connects to one instance; resolves once channels are subscribed and presence is initialised. */
const connect = (instance: Instance, user: TestUser) =>
  new Promise<{ socket: Socket; presence: { id: string }[] }>((resolve, reject) => {
    const socket = ioClient(instance.url, { auth: { token: user.token }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    let subscribed = false;
    let presence: { id: string }[] | null = null;
    const done = () => {
      if (!subscribed || !presence) return;
      clearTimeout(timer);
      resolve({ socket, presence });
    };
    const timer = setTimeout(() => reject(new Error(`socket to ${instance.name} did not become ready`)), 10_000);
    socket.once('subscriptions:ready', () => {
      subscribed = true;
      done();
    });
    socket.once('presence:init', (p: { users: { id: string }[] }) => {
      presence = p.users;
      done();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

const api = (instance: Instance, user: TestUser, method: string, path: string, body?: unknown) =>
  fetch(`${instance.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A workspace (owner) plus `memberCount` members, all in its General channel. */
const team = async (memberCount: number) => {
  const owner = await createAndLoginUser();
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  const members: TestUser[] = [];
  for (let i = 0; i < memberCount; i++) {
    const m = await createAndLoginUser();
    await addToWorkspace(m, workspaceId, [generalChannelId]);
    members.push(m);
  }
  return { owner, members, workspaceId, generalChannelId };
};

describe.skipIf(!TEST_REDIS_URL)('two backend instances sharing Redis (T.33)', () => {
  let A: Instance;
  let B: Instance;

  beforeAll(async () => {
    if (!/^redis:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\d+$/.test(TEST_REDIS_URL!)) {
      throw new Error('TEST_REDIS_URL must be a local redis://127.0.0.1:<port>/<db> — this test flushes it.');
    }
    const redis = new Redis(TEST_REDIS_URL!);
    await redis.flushdb();
    await redis.quit();
    workDir = mkdtempSync(join(tmpdir(), 'sc-t33-'));
    [A, B] = await Promise.all([startInstance('A'), startInstance('B')]);
  }, 90_000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await Promise.all([stopInstance(A), stopInstance(B)]);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }, 60_000);

  // On failure, show what the instances logged (errors only — the dev log
  // level also prints every SQL query).
  afterEach((ctx) => {
    if (ctx.task.result?.state !== 'fail') return;
    for (const instance of [A, B]) {
      const lines = instance.output.join('').split('\n').filter((l) => /error|fail|presence|redis/i.test(l) && !/prisma:query/.test(l));
      console.error(`--- instance ${instance.name} ---\n${lines.slice(-40).join('\n')}`);
    }
  });

  it('both instances report ready with Redis and the database connected', async () => {
    for (const instance of [A, B]) {
      const res = await fetch(`${instance.url}/api/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ready: true, database: 'ok', redis: 'ok', draining: false });
    }
  });

  it('a message sent through instance A reaches a member connected to instance B — and nobody outside the channel', async () => {
    const t = await team(1);
    const [bob] = t.members;
    const outsider = await createAndLoginUser();
    await createWorkspace(outsider);

    const alice = await connect(A, t.owner);
    const bobConn = await connect(B, bob);
    const outsiderConn = await connect(B, outsider);
    const leaked = collect(outsiderConn.socket, 'message:received', 1500);

    const received = nextEvent<{ content: string }>(bobConn.socket, 'message:received', (m) => m.content === 'hello from A', 5000);
    const ack = await emitAck(alice.socket, 'message:send', { channelId: t.generalChannelId, content: 'hello from A' });
    expect(ack.ok).toBe(true);
    expect((await received).content).toBe('hello from A');
    expect(await leaked).toEqual([]);
  });

  it('presence is shared: online/offline seen across instances, snapshots include remote users', async () => {
    const t = await team(1);
    const [bob] = t.members;
    const bobConn = await connect(B, bob);
    const online = nextEvent<{ id: string }>(bobConn.socket, 'user:online', (u) => u.id === t.owner.user.id, 5000);
    const alice = await connect(A, t.owner);
    await online;
    expect(alice.presence.map((u) => u.id)).toContain(bob.user.id); // bob is on the other instance

    const offline = nextEvent<{ id: string }>(bobConn.socket, 'user:offline', (u) => u.id === t.owner.user.id, 5000);
    alice.socket.disconnect();
    await offline;

    const members = await (await api(A, bob, 'GET', `/api/workspaces/${t.workspaceId}/members`)).json();
    const me = (members.members as { id: string; presence: { status: string } | null }[]).find((m) => m.id === bob.user.id);
    expect(me?.presence?.status).toBe('active'); // instance A answers for a socket held by B
  });

  it('removing a member through instance A revokes their live socket on instance B', async () => {
    const t = await team(1);
    const [bob] = t.members;
    const alice = await connect(A, t.owner);
    const bobConn = await connect(B, bob);
    // Positive control: before the removal bob (on B) does receive A's messages.
    const before = nextEvent<{ content: string }>(bobConn.socket, 'message:received', (m) => m.content === 'before removal', 5000);
    expect((await emitAck(alice.socket, 'message:send', { channelId: t.generalChannelId, content: 'before removal' })).ok).toBe(true);
    await before;

    const res = await api(A, t.owner, 'DELETE', `/api/workspaces/${t.workspaceId}/members/${bob.user.id}`);
    expect(res.status).toBe(200);
    await sleep(500);

    const leaked = collect<{ content: string }>(bobConn.socket, 'message:received', 1500);
    expect((await emitAck(alice.socket, 'message:send', { channelId: t.generalChannelId, content: 'after removal' })).ok).toBe(true);
    expect((await leaked).map((m) => m.content)).not.toContain('after removal');
  });

  it('logging out through instance A ends the same session’s socket on instance B', async () => {
    const t = await team(0);
    const conn = await connect(B, t.owner);
    const dropped = new Promise<string>((resolve) => conn.socket.once('disconnect', resolve));
    expect((await api(A, t.owner, 'POST', '/api/auth/logout')).status).toBe(200);
    expect(await Promise.race([dropped, sleep(5000).then(() => 'still connected')])).toBe('io server disconnect');
  });

  it('calls span instances: ringing, decline, signalling relay and a global participant cap', async () => {
    const t = await team(2);
    const [bob, carol] = t.members;
    const dm = await createDM(t.owner, bob, t.workspaceId);
    const alice = await connect(A, t.owner);
    const bobConn = await connect(B, bob);
    const carolConn = await connect(A, carol);

    // Ring from A, decline on B.
    const incoming = nextEvent<{ from: string }>(bobConn.socket, 'call:incoming', () => true, 5000);
    alice.socket.emit('call:initiate', { channelId: dm.id, callType: 'audio' });
    expect((await incoming).from).toBe(t.owner.user.id);
    const declined = nextEvent<{ userId: string }>(alice.socket, 'call:declined', () => true, 5000);
    const ended = nextEvent<{ reason: string }>(bobConn.socket, 'call:ring_ended', () => true, 5000);
    bobConn.socket.emit('call:decline', { channelId: dm.id });
    expect((await declined).userId).toBe(bob.user.id);
    expect((await ended).reason).toBe('declined');

    // Media signalling between A and B in the team channel.
    const existingA = nextEvent<{ participants: unknown[] }>(alice.socket, 'webrtc:existing-participants', () => true, 5000);
    alice.socket.emit('webrtc:join', { channelId: t.generalChannelId });
    expect((await existingA).participants).toEqual([]);
    const peerJoined = nextEvent<{ socketId: string }>(alice.socket, 'webrtc:peer-joined', () => true, 5000);
    const existingB = nextEvent<{ participants: { socketId: string }[] }>(bobConn.socket, 'webrtc:existing-participants', () => true, 5000);
    bobConn.socket.emit('webrtc:join', { channelId: t.generalChannelId });
    expect((await existingB).participants.map((p) => p.socketId)).toEqual([alice.socket.id]);
    expect((await peerJoined).socketId).toBe(bobConn.socket.id);

    const offer = nextEvent<{ from: string; offer: { type: string } }>(alice.socket, 'webrtc:offer', () => true, 5000);
    bobConn.socket.emit('webrtc:offer', { channelId: t.generalChannelId, to: alice.socket.id, offer: { type: 'offer', sdp: 'v=0\r\n' } });
    expect(await offer).toMatchObject({ from: bobConn.socket.id, offer: { type: 'offer' } });
    const candidate = nextEvent<{ from: string }>(bobConn.socket, 'webrtc:ice-candidate', () => true, 5000);
    alice.socket.emit('webrtc:ice-candidate', { channelId: t.generalChannelId, to: bobConn.socket.id, candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    expect((await candidate).from).toBe(alice.socket.id);

    // CALL_MAX_PARTICIPANTS=2 across BOTH instances: carol (on A) is refused.
    const full = nextEvent<{ code?: string }>(carolConn.socket, 'webrtc:error', () => true, 5000);
    carolConn.socket.emit('webrtc:join', { channelId: t.generalChannelId });
    expect((await full).code).toBe('call_full');

    // Leaving on B frees the seat and A's participant is told.
    const left = nextEvent<{ socketId: string }>(alice.socket, 'webrtc:peer-left', () => true, 5000);
    bobConn.socket.emit('webrtc:leave', { channelId: t.generalChannelId });
    expect((await left).socketId).toBe(bobConn.socket.id);
  });

  it('HTTP rate limits are one budget across instances (and 429 carries Retry-After)', async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 11; i++) {
      const instance = i % 2 === 0 ? A : B;
      const res = await fetch(`${instance.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `nobody-${i}@example.com`, password: 'wrong-password' }),
      });
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
    }
    // login allows 10 per window per IP. Per-instance counting would allow 20.
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('socket event budgets are per user across instances', async () => {
    const t = await team(0);
    const onA = await connect(A, t.owner);
    const onB = await connect(B, t.owner);
    const acks = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        emitAck(i % 2 === 0 ? onA.socket : onB.socket, 'message:send', { channelId: t.generalChannelId, content: `burst ${i}` })
      )
    );
    // message:send allows 30 per 10 s per user; per-instance counting would allow all 40.
    expect(acks.filter((a) => a.ok)).toHaveLength(30);
    expect(acks.filter((a) => a.error === 'rate_limited')).toHaveLength(10);
  });

  it('a crashed instance’s users are swept offline and its call participants pruned', async () => {
    const t = await team(2);
    const [bob, dave] = t.members;
    const C = await startInstance('C');
    try {
      const alice = await connect(A, t.owner);
      const daveConn = await connect(C, dave);
      const daveJoined = nextEvent(daveConn.socket, 'webrtc:existing-participants', () => true, 5000);
      daveConn.socket.emit('webrtc:join', { channelId: t.generalChannelId });
      await daveJoined;

      const offline = nextEvent<{ id: string }>(alice.socket, 'user:offline', (u) => u.id === dave.user.id, 15_000);
      C.proc.kill('SIGKILL'); // no disconnect handlers run
      await offline;

      // dave's call seat was never released; the next join prunes it (CALL_MAX_PARTICIPANTS=2).
      const bobConn = await connect(B, bob);
      const existing = nextEvent<{ participants: { userId: string }[] }>(bobConn.socket, 'webrtc:existing-participants', () => true, 5000);
      bobConn.socket.emit('webrtc:join', { channelId: t.generalChannelId });
      expect((await existing).participants.map((p) => p.userId)).not.toContain(dave.user.id);
    } finally {
      if (C.proc.exitCode === null) C.proc.kill('SIGKILL');
    }
  }, 40_000);

  it('graceful shutdown: SIGTERM drains instance B, its users go offline elsewhere, exit code 0', async () => {
    const t = await team(1);
    const [bob] = t.members;
    const alice = await connect(A, t.owner);
    const bobConn = await connect(B, bob);
    const dropped = new Promise<string>((resolve) => bobConn.socket.once('disconnect', resolve));
    const offline = nextEvent<{ id: string }>(alice.socket, 'user:offline', (u) => u.id === bob.user.id, 10_000);

    B.proc.kill('SIGTERM');
    // 'transport close' (not 'io server disconnect'): Socket.IO clients
    // reconnect automatically after it — through the load balancer, to a
    // healthy instance — whereas a server-initiated disconnect is final.
    expect(await dropped).toBe('transport close');
    await offline; // B's disconnect handlers reached Redis before it closed
    expect(await Promise.race([B.exited, sleep(20_000).then(() => 'timeout')])).toBe(0);
    expect(B.output.join('')).toContain('Shutdown complete.');
    // A keeps serving.
    expect((await fetch(`${A.url}/api/ready`)).status).toBe(200);
  }, 40_000);
});
