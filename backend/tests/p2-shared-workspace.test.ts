import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import {
  ensureSharedWorkspace,
  ensureSharedWorkspaceMembership,
  reconcileSharedWorkspace,
  SHARED_WORKSPACE_NAME,
  SHARED_WORKSPACE_SLUG,
  SYSTEM_USER_EMAIL,
} from '../lib/sharedWorkspace';
import { createWorkspace } from './collab-helpers';
import { authHeader, createAndLoginUser } from './helpers';

/**
 * P2 — SmartConnect Collab: one canonical shared workspace every active
 * account can use, created/reconciled idempotently, locked against renames,
 * deletion, role changes and invitations. The shared workspace only exists for
 * the duration of this file (other files share the disposable database).
 */

const as = (u: { token: string }) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body?: object) => request(app).post(path).set(authHeader(u.token)).send(body ?? {}),
  patch: (path: string, body?: object) => request(app).patch(path).set(authHeader(u.token)).send(body ?? {}),
  del: (path: string) => request(app).delete(path).set(authHeader(u.token)),
});

const removeShared = async () => {
  const shared = await prisma.workspace.findUnique({ where: { slug: SHARED_WORKSPACE_SLUG }, select: { id: true, organizationId: true } });
  if (!shared) return;
  await prisma.workspace.delete({ where: { id: shared.id } });
  const org = shared.organizationId ? await prisma.organization.findUnique({ where: { id: shared.organizationId }, select: { id: true, isDefault: true, slug: true } }) : null;
  if (org?.isDefault && org.slug.startsWith('smartconnect')) await prisma.organization.delete({ where: { id: org.id } });
};

beforeAll(removeShared);
afterAll(removeShared);

const sharedChannelNames = async (workspaceId: string) =>
  (await prisma.channel.findMany({ where: { workspaceId, isDM: false }, select: { name: true, isAnnouncement: true }, orderBy: { name: 'asc' } }));

describe('SmartConnect Collab (P2)', () => {
  it('is created once — concurrent and repeated reconciles never duplicate it', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureSharedWorkspace()));
    const again = await ensureSharedWorkspace();
    expect(new Set([...results.map((r) => r.workspaceId), again.workspaceId]).size).toBe(1);
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: SHARED_WORKSPACE_SLUG }, include: { owner: { select: { email: true, status: true } } } });
    expect(workspace).toMatchObject({ name: SHARED_WORKSPACE_NAME, isDefault: true });
    expect(workspace.owner).toEqual({ email: SYSTEM_USER_EMAIL, status: 'SUSPENDED' }); // platform-owned, non-login
    expect(await sharedChannelNames(workspace.id)).toEqual([
      { name: 'Announcements', isAnnouncement: true },
      { name: 'General', isAnnouncement: false },
      { name: 'Random', isAnnouncement: false },
    ]);
    expect(await prisma.workspace.count({ where: { slug: SHARED_WORKSPACE_SLUG } })).toBe(1);
  });

  it('gives every active account access (backfill, lazily on first load, and on admin provisioning) — never inactive ones', async () => {
    const { workspaceId, channelIds } = await ensureSharedWorkspace();
    const active = await createAndLoginUser();
    const suspended = await createAndLoginUser();
    await prisma.user.update({ where: { id: suspended.user.id }, data: { status: 'SUSPENDED' } });

    const result = await reconcileSharedWorkspace();
    expect(result.membersAdded).toBeGreaterThanOrEqual(1);
    expect(await prisma.workspaceMember.count({ where: { workspaceId, userId: active.user.id } })).toBe(1);
    expect(await prisma.workspaceMember.count({ where: { workspaceId, userId: suspended.user.id } })).toBe(0);
    expect(await prisma.channelMember.count({ where: { userId: active.user.id, channelId: { in: channelIds } } })).toBe(3);
    expect((await reconcileSharedWorkspace()).membersAdded).toBe(0); // idempotent

    // Lazily, the first time a (new) account loads its workspace list.
    const newcomer = await createAndLoginUser();
    const list = await as(newcomer).get('/api/workspaces');
    expect(list.body.find((w: { id: string }) => w.id === workspaceId)).toMatchObject({ name: SHARED_WORKSPACE_NAME, isDefault: true });
    expect(await prisma.workspaceMember.count({ where: { workspaceId, userId: newcomer.user.id } })).toBe(1);
    expect((await as(newcomer).get(`/api/workspaces/${workspaceId}/channels`)).body.map((c: { name: string }) => c.name).sort()).toEqual(['Announcements', 'General', 'Random']);

    // Accounts a platform admin creates get it immediately.
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const t = randomUUID().slice(0, 8);
    const created = await as(admin).post('/api/admin/users', { username: `collab_${t}`, loginId: `collab_${t}@2003`, password: 'secret1' });
    expect(created.status).toBe(201);
    expect(await prisma.workspaceMember.count({ where: { workspaceId, userId: created.body.id } })).toBe(1);
  });

  it('"join once": a member who leaves Random is not re-added', async () => {
    const { workspaceId } = await ensureSharedWorkspace();
    const user = await createAndLoginUser();
    await ensureSharedWorkspaceMembership(user.user.id);
    const random = await prisma.channel.findFirstOrThrow({ where: { workspaceId, name: 'Random' } });
    expect((await as(user).post(`/api/channels/${random.id}/leave`)).status).toBe(200);
    await ensureSharedWorkspaceMembership(user.user.id);
    await as(user).get('/api/workspaces');
    await reconcileSharedWorkspace();
    expect(await prisma.channelMember.count({ where: { userId: user.user.id, channelId: random.id } })).toBe(0);
  });

  it('members collaborate there, but nobody can rename, delete, re-role, invite into or leave it', async () => {
    const { workspaceId } = await ensureSharedWorkspace();
    const user = await createAndLoginUser();
    const other = await createAndLoginUser();
    await ensureSharedWorkspaceMembership(user.user.id);
    await ensureSharedWorkspaceMembership(other.user.id);

    expect((await as(user).post('/api/channels', { workspaceId, name: `team-${randomUUID().slice(0, 6)}` })).status).toBe(201);
    expect((await as(user).patch(`/api/workspaces/${workspaceId}`, { name: 'Hijacked' })).status).toBe(403);
    expect((await as(user).del(`/api/workspaces/${workspaceId}`)).status).toBe(403);
    expect((await as(user).patch(`/api/workspaces/${workspaceId}/members/${other.user.id}`, { role: 'ADMIN' })).status).toBe(403);
    expect((await as(user).post(`/api/workspaces/${workspaceId}/members`, { userId: other.user.id })).status).toBe(403);
    expect((await as(user).get(`/api/workspaces/${workspaceId}/invite-link`)).status).toBe(403);
    expect((await as(user).post(`/api/workspaces/${workspaceId}/leave`)).status).toBe(400);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).name).toBe(SHARED_WORKSPACE_NAME);
    const settings = await as(user).get(`/api/workspaces/${workspaceId}/settings`);
    expect(settings.body.capabilities).toMatchObject({ canUpdateSettings: false });
  });

  it('a pre-existing default workspace is reconciled in place, without losing anything', async () => {
    await removeShared();
    const owner = await createAndLoginUser();
    const legacy = await createWorkspace(owner, `Legacy ${randomUUID().slice(0, 6)}`);
    await prisma.workspace.update({ where: { id: legacy.workspaceId }, data: { slug: SHARED_WORKSPACE_SLUG, name: 'Default Workspace', isDefault: false } });
    await prisma.message.create({ data: { channelId: legacy.generalChannelId, workspaceId: legacy.workspaceId, senderId: owner.user.id, content: '<p>history kept</p>' } });

    const { workspaceId, channelIds } = await ensureSharedWorkspace();
    expect(workspaceId).toBe(legacy.workspaceId);
    expect(channelIds).toContain(legacy.generalChannelId); // the existing General is reused, not duplicated
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).toMatchObject({ name: SHARED_WORKSPACE_NAME, isDefault: true });
    expect((await sharedChannelNames(workspaceId)).map((c) => c.name)).toEqual(['Announcements', 'General', 'Random']);
    expect(await prisma.message.count({ where: { channelId: legacy.generalChannelId, content: '<p>history kept</p>' } })).toBe(1);
    expect(await prisma.workspaceMember.count({ where: { workspaceId, userId: owner.user.id } })).toBe(1);
  });
});
