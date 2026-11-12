import Redis from 'ioredis';

/**
 * Redis connection (T.33 — horizontal scaling).
 *
 * Opt-in: set REDIS_URL (e.g. redis://localhost:6379, or rediss://… for TLS).
 * Without it the app runs exactly as before — one process, in-memory
 * presence, call state and rate-limit windows — which is correct for a single
 * instance. With it:
 *   - Socket.IO uses the Redis adapter (events reach sockets on every instance);
 *   - presence, call participants and rings live in Redis (shared);
 *   - HTTP and socket rate limits are counted in Redis (one budget across
 *     instances).
 *
 * Redis is never the source of truth for durable data (messages, tasks,
 * sessions stay in PostgreSQL). Failure handling: commands time out quickly;
 * rate limiters fail OPEN (a Redis outage must not lock everyone out); the
 * readiness probe reports Redis as unavailable so a load balancer stops
 * routing to an instance that cannot reach it.
 */
export const REDIS_URL = process.env.REDIS_URL?.trim() || null;

export const redisEnabled = () => REDIS_URL !== null;

const clients: Redis[] = [];
let commandClient: Redis | null = null;

const connect = (name: string): Redis => {
  const client = new Redis(REDIS_URL as string, {
    connectionName: `smartconnect:${name}`,
    // Fail fast instead of queueing commands forever while Redis is down.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  client.on('error', (err) => {
    // ioredis retries on its own; log once per distinct message to avoid floods.
    const key = `${name}:${err.message}`;
    if (!loggedErrors.has(key)) {
      loggedErrors.add(key);
      console.error(`Redis (${name}) error: ${err.message}`);
    }
  });
  client.on('ready', () => loggedErrors.clear());
  clients.push(client);
  return client;
};
const loggedErrors = new Set<string>();

/** The shared command connection (null when Redis is not configured). */
export const getRedis = (): Redis | null => {
  if (!redisEnabled()) return null;
  commandClient ??= connect('commands');
  return commandClient;
};

/** A dedicated publish/subscribe pair for the Socket.IO adapter. */
export const createAdapterClients = (): { pub: Redis; sub: Redis } | null => {
  if (!redisEnabled()) return null;
  const pub = connect('socket-pub');
  const sub = pub.duplicate({ connectionName: 'smartconnect:socket-sub' });
  sub.on('error', (err) => console.error(`Redis (socket-sub) error: ${err.message}`));
  clients.push(sub);
  return { pub, sub };
};

/** Readiness: true when Redis is not used, or answers PING within 1 s. */
export const redisHealthy = async (): Promise<boolean | null> => {
  const client = getRedis();
  if (!client) return null;
  try {
    const answer = await Promise.race([client.ping(), new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1_000))]);
    return answer === 'PONG';
  } catch {
    return false;
  }
};

/** Graceful shutdown. */
export const closeRedis = async () => {
  await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
  clients.length = 0;
  commandClient = null;
};
