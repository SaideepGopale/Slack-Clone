import rateLimit, { Options, RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedis } from '../lib/redis';

/**
 * One factory for every HTTP rate limiter (T.33).
 *
 * - With REDIS_URL set, hits are counted in Redis, so the budget is shared by
 *   every backend instance (a client cannot multiply its allowance by being
 *   routed to different instances). Without it, counting is in memory (one
 *   instance — the previous behaviour).
 * - `passOnStoreError`: if Redis is unreachable the request is allowed
 *   (fail open) rather than blocking every user; the outage shows on /api/ready.
 * - Standard `RateLimit-*` headers and `Retry-After` on 429.
 * - Skipped under NODE_ENV=test (the existing convention); tests switch it on.
 */
export const createLimiter = (name: string, options: Partial<Options>): RateLimitRequestHandler => {
  const client = getRedis();
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: () => process.env.NODE_ENV === 'test',
    ...options,
    ...(client
      ? {
          store: new RedisStore({
            prefix: `rl:${name}:`,
            sendCommand: (command: string, ...args: string[]) => client.call(command, ...args) as Promise<never>,
          }),
        }
      : {}),
  });
};
