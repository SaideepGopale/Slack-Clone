import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Role } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../lib/prisma';

// Random per-call identifiers instead of table truncation between tests —
// simplest way to keep every test's data isolated when the whole suite
// shares one database.
export const uniqueEmail = () => `test-${randomUUID()}@example.com`;
export const uniqueUsername = () => `user_${randomUUID().slice(0, 8)}`;

/**
 * Creates a user directly via Prisma (bypassing the OTP signup flow) and
 * logs them in through the real POST /api/auth/login endpoint, so tests that
 * only care about "an authenticated user" don't each need to drive the full
 * signup-request/verify-otp dance themselves.
 */
export const createAndLoginUser = async (overrides: { role?: Role } = {}) => {
  const email = uniqueEmail();
  const username = uniqueUsername();
  const password = 'Password123!';

  const user = await prisma.user.create({
    data: {
      email,
      username,
      password: await bcrypt.hash(password, 12),
      role: overrides.role ?? 'USER',
    },
  });

  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`Test helper login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return { user, token: res.body.token as string };
};

export const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
