import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

/**
 * T.33: optional pool sizing from the environment, applied only when the URL
 * does not already set it (an explicit `?connection_limit=` always wins).
 * Each instance opens up to `connection_limit` connections, so the total
 * across instances must stay under the database/pooler limit (see the
 * capacity notes in README "Scaling").
 */
export const databaseUrlWithPool = (raw: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  if (!raw) return raw;
  const limit = env.DATABASE_CONNECTION_LIMIT?.trim();
  const timeout = env.DATABASE_POOL_TIMEOUT?.trim();
  if (!limit && !timeout) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (limit && /^\d{1,3}$/.test(limit) && !url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', limit);
  if (timeout && /^\d{1,3}$/.test(timeout) && !url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', timeout);
  return url.toString();
};

const datasourceUrl = databaseUrlWithPool(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
    ...(datasourceUrl && datasourceUrl !== process.env.DATABASE_URL ? { datasourceUrl } : {}),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
