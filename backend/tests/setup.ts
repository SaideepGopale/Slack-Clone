import { execSync } from 'child_process';
import { afterAll, beforeAll } from 'vitest';

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
