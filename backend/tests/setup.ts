import { execSync } from 'child_process';
import http from 'http';
import net from 'net';
import { afterAll, beforeAll } from 'vitest';

// Node >= 19 enables keep-alive on http.globalAgent. supertest starts a fresh
// ephemeral server for every `request(app)` call; when a new server lands on
// a recently freed port, a stale pooled keep-alive socket can be reused and
// is reset ("socket hang up"/ECONNRESET) — an intermittent test-harness
// failure unrelated to app code. Test-only: plain, non-pooled connections.
http.globalAgent = new http.Agent({ keepAlive: false });

// macOS hands out ephemeral ports sequentially, and supertest's `request(app)`
// listens on the wildcard address (`app.listen(0)`) while connecting to
// 127.0.0.1. A wildcard listener can be given a port another local process
// (IDE helpers, databases) already holds on 127.0.0.1, and the request then
// reaches that process — random 401 / 404 / "Parse Error: Expected HTTP/"
// failures in unrelated tests (diagnosed in Batch 3/C; see
// tests/test-harness.test.ts). Test-only: a wildcard ephemeral listen is bound
// to 127.0.0.1 instead, where the kernel refuses ports that are already taken.
// supertest reads app.address() synchronously right after listen(0), and a
// host argument would make listen asynchronous (DNS lookup step), so this
// wraps Node's synchronous `_listen2` step (kept under that name in Node's
// net.js precisely so it can be wrapped) for that one call shape only.
type Listen2 = (this: net.Server, address: string | null, port: number, addressType: number, ...rest: unknown[]) => void;
const serverInternals = net.Server.prototype as unknown as { _listen2: Listen2 };
const originalListen2 = serverInternals._listen2;
serverInternals._listen2 = function (this: net.Server, address, port, addressType, ...rest) {
  if (address === null && port === 0) return originalListen2.call(this, '127.0.0.1', 0, 4, ...rest);
  return originalListen2.call(this, address, port, addressType, ...rest);
};

// config/env.ts exits the process if these are missing — dummy values are
// fine here since none of the critical-path tests actually call Cloudinary,
// only its env-var presence check at import time.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-do-not-use-in-production';
process.env.CLOUDINARY_CLOUD_NAME ??= 'test-cloud';
process.env.CLOUDINARY_API_KEY ??= 'test-key';
process.env.CLOUDINARY_API_SECRET ??= 'test-secret';

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL must be set to run the backend test suite — point it at a disposable Postgres database, never a real one.'
    );
  }
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
});

afterAll(async () => {
  const { prisma } = await import('../lib/prisma');
  await prisma.$disconnect();
});
