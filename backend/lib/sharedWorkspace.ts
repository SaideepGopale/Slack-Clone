import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * SmartConnect Collab — the one platform-managed workspace every active
 * account can use (P2).
 *
 * It is the existing "Default Workspace" concept, made canonical:
 *  - identified by slug 'default' (what signup already joins, see
 *    auth.service joinGeneralChannel) and flagged isDefault (which lib/policy
 *    already treats as "everyone may open it; nobody may delete it");
 *  - owned by a non-login system account, so no ordinary user owns it;
 *  - General, Announcements (announcement channel) and Random.
 *
 * Everything here is idempotent and additive: it creates what is missing,
 * sets the canonical name/flag, and adds memberships. It never deletes,
 * renames channels, or removes anyone. Creation runs under a Postgres
 * advisory lock so concurrent servers/requests can't create two copies.
 */

export const SHARED_WORKSPACE_SLUG = 'default';
export const SHARED_WORKSPACE_NAME = 'SmartConnect Collab';
const SHARED_WORKSPACE_DESCRIPTION = 'The shared space for everyone at SmartConnect.';
const SHARED_ORGANIZATION_NAME = 'SmartConnect';
const SHARED_ORGANIZATION_SLUG = 'smartconnect';

export const SHARED_CHANNELS = [
  { name: 'General', isAnnouncement: false, description: 'Company-wide conversation for everyone.' },
  { name: 'Announcements', isAnnouncement: true, description: 'Official announcements and updates.' },
  { name: 'Random', isAnnouncement: false, description: 'Off-topic chat, ideas and everything else.' },
] as const;

// Reserved, non-login account that owns platform-managed resources. Its
// password is a random hash nobody knows and it is SUSPENDED, which login and
// the socket handshake both refuse.
export const SYSTEM_USER_EMAIL = 'system@smartconnect.internal';
const SYSTEM_USERNAME = 'smartconnect_system';
const RECONCILE_LOCK_KEY = 8_427_301; // arbitrary, fixed advisory-lock id

const getOrCreateSystemUser = async (tx: Prisma.TransactionClient) => {
  const existing = await tx.user.findUnique({ where: { email: SYSTEM_USER_EMAIL }, select: { id: true } });
  if (existing) return existing;
  const taken = await tx.user.findUnique({ where: { username: SYSTEM_USERNAME }, select: { id: true } });
  return tx.user.create({
    data: {
      username: taken ? `${SYSTEM_USERNAME}_${crypto.randomBytes(3).toString('hex')}` : SYSTEM_USERNAME,
      email: SYSTEM_USER_EMAIL,
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
      status: 'SUSPENDED',
    },
    select: { id: true },
  });
};

const getOrCreateSharedOrganization = async (tx: Prisma.TransactionClient, ownerId: string) => {
  const existing =
    (await tx.organization.findFirst({ where: { isDefault: true }, orderBy: { createdAt: 'asc' }, select: { id: true } })) ??
    (await tx.organization.findUnique({ where: { slug: SHARED_ORGANIZATION_SLUG }, select: { id: true } }));
  if (existing) return existing;
  let slug = SHARED_ORGANIZATION_SLUG;
  for (let n = 2; await tx.organization.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${SHARED_ORGANIZATION_SLUG}-${n}`;
  const organization = await tx.organization.create({ data: { name: SHARED_ORGANIZATION_NAME, slug, isDefault: true }, select: { id: true } });
  await tx.organizationMember.create({ data: { organizationId: organization.id, userId: ownerId, role: 'OWNER' } });
  return organization;
};

/** Creates or reconciles the canonical shared workspace and its channels. Returns its id and channel ids. */
export const ensureSharedWorkspace = async () =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RECONCILE_LOCK_KEY})`;
    const system = await getOrCreateSystemUser(tx);
    let workspace = await tx.workspace.findUnique({
      where: { slug: SHARED_WORKSPACE_SLUG },
      select: { id: true, name: true, isDefault: true, organizationId: true },
    });
    if (!workspace) {
      const organization = await getOrCreateSharedOrganization(tx, system.id);
      workspace = await tx.workspace.create({
        data: {
          name: SHARED_WORKSPACE_NAME,
          slug: SHARED_WORKSPACE_SLUG,
          isDefault: true,
          description: SHARED_WORKSPACE_DESCRIPTION,
          ownerId: system.id,
          organizationId: organization.id,
        },
        select: { id: true, name: true, isDefault: true, organizationId: true },
      });
    } else if (!workspace.isDefault || workspace.name !== SHARED_WORKSPACE_NAME || !workspace.organizationId) {
      const organizationId = workspace.organizationId ?? (await getOrCreateSharedOrganization(tx, system.id)).id;
      workspace = await tx.workspace.update({
        where: { id: workspace.id },
        data: { isDefault: true, name: SHARED_WORKSPACE_NAME, organizationId },
        select: { id: true, name: true, isDefault: true, organizationId: true },
      });
    }

    const channelIds: string[] = [];
    for (const spec of SHARED_CHANNELS) {
      const found = await tx.channel.findFirst({
        where: { workspaceId: workspace.id, isDM: false, name: { equals: spec.name, mode: 'insensitive' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      const channel =
        found ??
        (await tx.channel.create({
          data: {
            name: spec.name,
            description: spec.description,
            isAnnouncement: spec.isAnnouncement,
            visibility: 'PUBLIC',
            workspaceId: workspace.id,
            createdBy: system.id,
          },
          select: { id: true },
        }));
      channelIds.push(channel.id);
    }
    return { workspaceId: workspace.id, channelIds };
  });

const sharedWorkspaceTarget = async () => {
  const workspace = await prisma.workspace.findUnique({ where: { slug: SHARED_WORKSPACE_SLUG }, select: { id: true, isDefault: true } });
  if (!workspace?.isDefault) return null;
  const channels = await prisma.channel.findMany({
    where: {
      workspaceId: workspace.id,
      isDM: false,
      archivedAt: null,
      OR: SHARED_CHANNELS.map((c) => ({ name: { equals: c.name, mode: 'insensitive' as const } })),
    },
    select: { id: true },
  });
  return { workspaceId: workspace.id, channelIds: channels.map((c) => c.id) };
};

/**
 * Gives one ACTIVE account its first-time access to the shared workspace
 * (membership plus the default channels). "Join once": an existing member is
 * left alone, so someone who left Random is not re-added. A no-op when the
 * shared workspace hasn't been created yet. Returns the channels joined.
 */
export const ensureSharedWorkspaceMembership = async (userId: string) => {
  const target = await sharedWorkspaceTarget();
  if (!target) return null;
  const member = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: target.workspaceId } },
    select: { id: true },
  });
  if (member) return { workspaceId: target.workspaceId, joinedChannelIds: [] as string[] };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (user?.status !== 'ACTIVE') return null;
  await prisma.$transaction([
    prisma.workspaceMember.createMany({ data: [{ userId, workspaceId: target.workspaceId, role: 'MEMBER' }], skipDuplicates: true }),
    prisma.channelMember.createMany({
      data: target.channelIds.map((channelId) => ({ userId, channelId, role: 'member' })),
      skipDuplicates: true,
    }),
  ]);
  return { workspaceId: target.workspaceId, joinedChannelIds: target.channelIds };
};

/**
 * Startup reconciliation: ensure the shared workspace exists, then give every
 * ACTIVE account without a membership its first-time access. Batched,
 * insert-only (skipDuplicates), safe to run on every boot.
 */
export const reconcileSharedWorkspace = async () => {
  const { workspaceId, channelIds } = await ensureSharedWorkspace();
  let added = 0;
  for (;;) {
    const missing = await prisma.user.findMany({
      where: { status: 'ACTIVE', email: { not: SYSTEM_USER_EMAIL }, workspaces: { none: { workspaceId } } },
      select: { id: true },
      take: 500,
    });
    if (missing.length === 0) break;
    await prisma.$transaction([
      prisma.workspaceMember.createMany({ data: missing.map((u) => ({ userId: u.id, workspaceId, role: 'MEMBER' as const })), skipDuplicates: true }),
      prisma.channelMember.createMany({
        data: missing.flatMap((u) => channelIds.map((channelId) => ({ userId: u.id, channelId, role: 'member' }))),
        skipDuplicates: true,
      }),
    ]);
    added += missing.length;
  }
  return { workspaceId, channelIds, membersAdded: added };
};
