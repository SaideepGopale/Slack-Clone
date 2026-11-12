import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { BOOTSTRAP_CONFIRM_PHRASE, bootstrapFirstAdmin } from '../lib/adminBootstrap';
import { prisma } from '../lib/prisma';
import { uniqueEmail, uniqueUsername } from './helpers';

/**
 * T.32 — audit H6: a fresh production database had no way to create the
 * first Company Admin. `npm run admin:bootstrap` (lib/adminBootstrap.ts)
 * creates exactly one, once, with operator-supplied credentials.
 *
 * The shared test database already contains ADMIN accounts from other test
 * files, so this file demotes them for its duration and restores them
 * afterwards (the suite runs files one at a time in a single fork).
 */
const STRONG = 'Bootstrap-Pass-2026!';
let demoted: string[] = [];

beforeAll(async () => {
  demoted = (await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })).map((u) => u.id);
  await prisma.user.updateMany({ where: { id: { in: demoted } }, data: { role: 'USER' } });
});

afterAll(async () => {
  await prisma.user.updateMany({ where: { id: { in: demoted } }, data: { role: 'ADMIN' } });
});

const input = (overrides: Partial<Record<'confirm' | 'email' | 'username' | 'password', unknown>> = {}) => ({
  confirm: BOOTSTRAP_CONFIRM_PHRASE,
  email: uniqueEmail(),
  username: uniqueUsername(),
  password: STRONG,
  ...overrides,
});

describe('T.32 H6 — first Company Admin bootstrap', () => {
  it('refuses without the explicit confirmation phrase, with invalid input, or a weak password — creating nothing', async () => {
    const before = await prisma.user.count();
    for (const bad of [
      input({ confirm: undefined }),
      input({ confirm: 'yes' }),
      input({ email: 'not-an-email' }),
      input({ username: 'a b' }),
      input({ password: 'short' }),
      input({ password: 'alllowercaseletters' }),
      input({ password: undefined }),
    ]) {
      await expect(bootstrapFirstAdmin(bad)).rejects.toMatchObject({ status: 400 });
    }
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(0);
  });

  it('creates exactly one active ADMIN, audits it, and that admin can sign in and reach the admin API', async () => {
    const data = input();
    const admin = await bootstrapFirstAdmin(data);
    expect(admin).toMatchObject({ username: data.username });
    expect(JSON.stringify(admin)).not.toContain(STRONG);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
    expect(row.password).not.toBe(STRONG);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'BOOTSTRAP_ADMIN', targetId: admin.id } });
    expect(audit.details).not.toContain(STRONG);

    const login = await request(app).post('/api/auth/login').send({ email: data.email, password: STRONG });
    expect(login.status).toBe(200);
    expect((await request(app).get('/api/admin/users').set('Authorization', `Bearer ${login.body.token}`)).status).toBe(200);
  });

  it('is one-time: once any administrator exists it refuses (409) and creates nothing', async () => {
    const before = await prisma.user.count();
    await expect(bootstrapFirstAdmin(input())).rejects.toMatchObject({ status: 409 });
    expect(await prisma.user.count()).toBe(before);
  });

  it('concurrent runs on an admin-less database create exactly one admin', async () => {
    // Remove the admin created above for this check (it owns no content yet).
    const created = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: created.map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: created.map((u) => u.id) } } });

    const results = await Promise.allSettled([bootstrapFirstAdmin(input()), bootstrapFirstAdmin(input()), bootstrapFirstAdmin(input())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
  });

  it('refuses an e-mail or username that already exists (any letter case)', async () => {
    const created = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: created.map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: created.map((u) => u.id) } } });
    const existing = await prisma.user.create({ data: { email: uniqueEmail(), username: uniqueUsername(), password: 'x' } });
    await expect(bootstrapFirstAdmin(input({ email: existing.email.toUpperCase() }))).rejects.toMatchObject({ status: 409 });
    await expect(bootstrapFirstAdmin(input({ username: existing.username }))).rejects.toMatchObject({ status: 409 });
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(0);
  });
});
