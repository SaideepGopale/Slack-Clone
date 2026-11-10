import { Prisma } from '@prisma/client';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { isUuid } from '../../lib/messageInput';
import {
  assertCanCreateOrganization,
  assertCanHoldElevatedRole,
  assertOrganization,
  canChangeOrganizationRole,
  canCreateWorkspaces,
  canHoldElevatedRoles,
  canOrganization,
  canRemoveOrganizationMember,
  canSeeOrganizationMemberEmails,
  DirectoryViewer,
  HierarchyActor,
  loadHierarchyActor,
  loadHierarchyActors,
  loadOrganizationActor,
  OrganizationRoleName,
  visibleEmail,
} from '../../lib/policy';
import { prisma } from '../../lib/prisma';
import { slugify } from '../../lib/slug';
import { emitToRooms } from '../../sockets/registry';
import { detachFromWorkspace, DetachResult } from '../members/members.service';

/**
 * Organizations (Batch 3/B): the top of Organization → Workspace → Channel.
 * Authorization decisions all go through lib/policy.
 */

const NAME_MAX = 80;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

type Tx = Prisma.TransactionClient;

const validateName = (raw: unknown, label: string): string => {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new HttpError(400, `${label} name is required.`);
  if (name.length > NAME_MAX) throw new HttpError(400, `${label} name must be ${NAME_MAX} characters or fewer.`);
  return name;
};

export const uniqueOrganizationSlug = async (db: Tx | typeof prisma, base: string) => {
  const root = slugify(base) || 'organization';
  let slug = root;
  for (let suffix = 2; await db.organization.findUnique({ where: { slug }, select: { id: true } }); suffix += 1) {
    slug = `${root}-${suffix}`;
  }
  return slug;
};

class LostRace extends Error {}

/**
 * Guarantees a workspace belongs to an organization. Backfilled workspaces
 * already do; this covers workspaces created by paths that predate
 * organizations (e.g. the frozen reset.ts tooling). Mirrors the migration
 * backfill: a new organization named after the workspace (or "Default
 * Organization"), owner → OWNER, workspace ADMIN → ADMIN, others → MEMBER.
 * Race-safe: only one concurrent caller can attach an organization.
 */
export const ensureWorkspaceOrganization = async (workspaceId: string): Promise<string> => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      organizationId: true,
      name: true,
      slug: true,
      isDefault: true,
      ownerId: true,
      members: { select: { userId: true, role: true } },
    },
  });
  if (!workspace) throw new HttpError(404, 'Workspace not found.');
  if (workspace.organizationId) return workspace.organizationId;

  // Stage 1 (T.19): a workspace ADMIN carries over as organization ADMIN only
  // when they may hold elevated roles (Team Lead / Company Admin). A legacy
  // ADMIN who is an ordinary Member becomes an organization MEMBER — they keep
  // their workspace row untouched, but gain no organization-level power.
  const workspaceAdminIds = workspace.members.filter((m) => m.role === 'ADMIN' && m.userId !== workspace.ownerId).map((m) => m.userId);
  const mayBeOrganizationAdmin = new Set(
    (await loadHierarchyActors(workspaceAdminIds)).filter(canHoldElevatedRoles).map((actor) => actor.userId)
  );

  try {
    return await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: workspace.isDefault ? 'Default Organization' : workspace.name,
          slug: await uniqueOrganizationSlug(tx, workspace.slug),
          isDefault: workspace.isDefault,
        },
      });
      const attached = await tx.workspace.updateMany({
        where: { id: workspaceId, organizationId: null },
        data: { organizationId: organization.id },
      });
      if (attached.count === 0) throw new LostRace();
      await tx.organizationMember.createMany({
        data: [
          { organizationId: organization.id, userId: workspace.ownerId, role: 'OWNER' as const },
          ...workspace.members
            .filter((m) => m.userId !== workspace.ownerId)
            .map((m) => ({
              organizationId: organization.id,
              userId: m.userId,
              role: m.role === 'ADMIN' && mayBeOrganizationAdmin.has(m.userId) ? ('ADMIN' as const) : ('MEMBER' as const),
            })),
        ],
        skipDuplicates: true,
      });
      return organization.id;
    });
  } catch (err) {
    if (!(err instanceof LostRace)) throw err;
    const winner = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { organizationId: true } });
    return winner!.organizationId!;
  }
};

/** Attaches organizations to any orphaned workspace this user can see. */
export const ensureOrganizationsForUser = async (userId: string) => {
  const orphans = await prisma.workspace.findMany({
    where: { organizationId: null, OR: [{ isDefault: true }, { members: { some: { userId } } }] },
    select: { id: true },
  });
  for (const orphan of orphans) await ensureWorkspaceOrganization(orphan.id);
};

/**
 * Keeps OrganizationMember in step when someone joins a workspace through a
 * non-frozen path (invite accepted, join request approved). Never downgrades
 * an existing role.
 */
export const ensureOrganizationMembership = async (workspaceId: string, userId: string) => {
  const organizationId = await ensureWorkspaceOrganization(workspaceId);
  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    update: {},
    create: { organizationId, userId, role: 'MEMBER' },
  });
};

/**
 * After someone leaves/is removed from a workspace: a plain MEMBER of a
 * (non-default) organization who no longer belongs to any of its workspaces
 * stops being an organization member. OWNER/ADMIN rows are explicit
 * appointments and are kept.
 */
export const pruneOrganizationMembership = async (workspaceId: string, userId: string) => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { organization: { select: { id: true, isDefault: true } } },
  });
  const organization = workspace?.organization;
  if (!organization || organization.isDefault) return;
  const remaining = await prisma.workspaceMember.count({ where: { userId, workspace: { organizationId: organization.id } } });
  if (remaining > 0) return;
  await prisma.organizationMember.deleteMany({ where: { organizationId: organization.id, userId, role: 'MEMBER' } });
};

// UI hints only — every action is re-checked on use. canCreateWorkspace also
// reflects the company hierarchy (Stage 1): only Team Leads/Company Admins.
const capabilitiesOf = (actor: Awaited<ReturnType<typeof loadOrganizationActor>>, hierarchy: HierarchyActor) => ({
  canUpdate: canOrganization(actor, 'organization.update'),
  canCreateWorkspace: canOrganization(actor, 'organization.createWorkspace') && canCreateWorkspaces(hierarchy),
  canChangeRoles: canOrganization(actor, 'organization.changeMemberRole'),
  canRemoveMembers: canOrganization(actor, 'organization.removeMember') && !actor.isDefaultOrganization,
});

/** Organizations the user belongs to: explicitly, through a workspace, or the Default Organization. */
export const listOrganizationsForUser = async (userId: string) => {
  await ensureOrganizationsForUser(userId);
  const organizations = await prisma.organization.findMany({
    where: {
      OR: [
        { members: { some: { userId } } },
        { workspaces: { some: { members: { some: { userId } } } } },
        { isDefault: true },
      ],
    },
    select: {
      id: true,
      name: true,
      slug: true,
      isDefault: true,
      createdAt: true,
      members: { where: { userId }, select: { role: true } },
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  const hierarchy = await loadHierarchyActor(userId);
  return organizations.map(({ members, ...organization }) => {
    const role = (members[0]?.role as OrganizationRoleName | undefined) ?? 'MEMBER';
    const actor = {
      userId,
      organizationId: organization.id,
      isDefaultOrganization: organization.isDefault,
      role,
      implicit: !members[0],
    };
    return { ...organization, myRole: role, capabilities: capabilitiesOf(actor, hierarchy) };
  });
};

/**
 * Organization details. Managers see every workspace of the organization;
 * members only see workspaces they belong to (plus the Default Workspace).
 */
export const getOrganization = async (userId: string, organizationId: string) => {
  const actor = await loadOrganizationActor(userId, organizationId);
  assertOrganization(actor, 'organization.view');
  const manager = canOrganization(actor, 'organization.update');
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      isDefault: true,
      createdAt: true,
      workspaces: {
        where: manager ? {} : { OR: [{ isDefault: true }, { members: { some: { userId } } }] },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          isDefault: true,
          ownerId: true,
          members: { where: { userId }, select: { role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!organization) throw new HttpError(404, 'Organization not found.');
  return {
    ...organization,
    workspaces: organization.workspaces.map(({ members, ownerId, ...w }) => ({
      ...w,
      isMember: members.length > 0 || w.isDefault,
      myRole: ownerId === userId ? 'OWNER' : members[0]?.role ?? (w.isDefault ? 'MEMBER' : null),
    })),
    myRole: actor.role,
    capabilities: capabilitiesOf(actor, await loadHierarchyActor(userId)),
  };
};

/** Everyone who should see an organization-level event. */
const organizationAudience = async (organizationId: string) => {
  const [workspaces, explicit] = await Promise.all([
    prisma.workspace.findMany({ where: { organizationId }, select: { id: true } }),
    prisma.organizationMember.findMany({ where: { organizationId }, select: { userId: true } }),
  ]);
  return { workspaceIds: workspaces.map((w) => w.id), userIds: explicit.map((m) => m.userId) };
};

export const emitToOrganization = async (organizationId: string, event: string, payload: unknown) => {
  const audience = await organizationAudience(organizationId);
  emitToRooms(audience.workspaceIds, audience.userIds, event, payload);
};

export const createOrganization = async (userId: string, rawName: unknown) => {
  // Stage 1 (T.19): only Company Admins and Team Leads create organizations.
  assertCanCreateOrganization(await loadHierarchyActor(userId));
  const name = validateName(rawName, 'Organization');
  const organization = await prisma.$transaction(async (tx) => {
    const created = await tx.organization.create({ data: { name, slug: await uniqueOrganizationSlug(tx, name) } });
    await tx.organizationMember.create({ data: { organizationId: created.id, userId, role: 'OWNER' } });
    return created;
  });
  await logAuditEvent(userId, 'CREATE_ORGANIZATION', 'ORGANIZATION', organization.id, `Created organization "${name}"`);
  return getOrganization(userId, organization.id);
};

export const updateOrganization = async (userId: string, organizationId: string, body: unknown) => {
  const actor = await loadOrganizationActor(userId, organizationId);
  assertOrganization(actor, 'organization.update');
  const name = validateName((body as { name?: unknown } | undefined)?.name, 'Organization');
  const updated = await prisma.organization.update({
    where: { id: organizationId },
    data: { name },
    select: { id: true, name: true, slug: true, isDefault: true },
  });
  await logAuditEvent(userId, 'UPDATE_ORGANIZATION', 'ORGANIZATION', organizationId, `Renamed organization to "${name}"`);
  await emitToOrganization(organizationId, 'organization:updated', updated);
  return updated;
};

/**
 * Members = explicit OrganizationMember rows ∪ members of the organization's
 * workspaces (derived MEMBER). Search by username/email; cursor = user id.
 */
export const listOrganizationMembers = async (
  userId: string,
  organizationId: string,
  query: { q?: unknown; cursor?: unknown; limit?: unknown }
) => {
  const actor = await loadOrganizationActor(userId, organizationId);
  assertOrganization(actor, 'organization.viewMembers');
  // P1-D (FA-SEC-03): e-mails, and searching by e-mail, only for explicit
  // organization OWNER/ADMINs (lib/policy) — everyone sees their own.
  const viewer: DirectoryViewer = { id: userId, canSeeEmails: canSeeOrganizationMemberEmails(actor) };
  const take = Math.min(Math.max(Number(query.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const cursor = isUuid(query.cursor) ? query.cursor : undefined;

  const rows = await prisma.user.findMany({
    where: {
      OR: [
        { organizationMemberships: { some: { organizationId } } },
        { workspaces: { some: { workspace: { organizationId } } } },
      ],
      ...(q
        ? {
            AND: [
              {
                OR: [
                  { username: { contains: q, mode: 'insensitive' as const } },
                  ...(viewer.canSeeEmails ? [{ email: { contains: q, mode: 'insensitive' as const } }] : []),
                ],
              },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      username: true,
      email: true,
      organizationMemberships: { where: { organizationId }, select: { role: true } },
    },
    orderBy: [{ username: 'asc' }, { id: 'asc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  return {
    members: page.map((u) => ({
      id: u.id,
      username: u.username,
      email: visibleEmail(viewer, u),
      role: (u.organizationMemberships[0]?.role as OrganizationRoleName | undefined) ?? 'MEMBER',
      explicit: u.organizationMemberships.length > 0,
    })),
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
  };
};

export const changeOrganizationRole = async (actorId: string, organizationId: string, targetId: unknown, rawRole: unknown) => {
  if (!isUuid(targetId)) throw new HttpError(400, 'Invalid user id.');
  if (rawRole !== 'ADMIN' && rawRole !== 'MEMBER') {
    throw new HttpError(400, 'role must be ADMIN or MEMBER (ownership transfer is not supported yet).');
  }
  const [actor, target] = await Promise.all([
    loadOrganizationActor(actorId, organizationId),
    loadOrganizationActor(targetId, organizationId),
  ]);
  assertOrganization(actor, 'organization.view');
  if (!target.role) throw new HttpError(404, 'This person is not a member of this organization.');
  if (!canChangeOrganizationRole(actor, { userId: targetId, role: target.role })) {
    throw new HttpError(403, 'Only the organization owner can change roles, and never their own or the owner\'s.');
  }
  // Stage 1 (T.19): organization ADMIN manages every workspace of the
  // organization — never for an ordinary Member. Demotion is never limited.
  if (rawRole === 'ADMIN') assertCanHoldElevatedRole(await loadHierarchyActor(targetId), 'organization');
  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId, userId: targetId } },
    update: { role: rawRole },
    create: { organizationId, userId: targetId, role: rawRole },
  });
  await logAuditEvent(actorId, 'CHANGE_ORGANIZATION_ROLE', 'USER', targetId, `Organization role set to ${rawRole}`);
  const payload = { organizationId, userId: targetId, role: rawRole };
  await emitToOrganization(organizationId, 'organization:member_updated', payload);
  return payload;
};

export interface OrganizationRemoval {
  organizationId: string;
  userId: string;
  detached: { workspaceId: string; result: DetachResult }[];
}

/**
 * Removes someone from an organization: every workspace membership in it
 * (with the same per-workspace cleanup as Batch 2) plus their organization
 * role. Refused for workspace owners — ownership must move first.
 */
export const removeOrganizationMember = async (actorId: string, organizationId: string, targetId: unknown): Promise<OrganizationRemoval> => {
  if (!isUuid(targetId)) throw new HttpError(400, 'Invalid user id.');
  const [actor, target] = await Promise.all([
    loadOrganizationActor(actorId, organizationId),
    loadOrganizationActor(targetId, organizationId),
  ]);
  assertOrganization(actor, 'organization.view');
  if (!target.role) throw new HttpError(404, 'This person is not a member of this organization.');
  if (actor.isDefaultOrganization) {
    throw new HttpError(400, 'Membership of the default organization cannot be changed — every account can access it.');
  }
  if (!canRemoveOrganizationMember(actor, { userId: targetId, role: target.role })) {
    throw new HttpError(403, 'You cannot remove this member.');
  }
  const owned = await prisma.workspace.count({ where: { organizationId, ownerId: targetId } });
  if (owned > 0) throw new HttpError(400, 'This person owns a workspace in this organization. Transfer or delete it first.');

  const workspaces = await prisma.workspace.findMany({
    where: { organizationId, members: { some: { userId: targetId } } },
    select: { id: true },
  });
  const detached: OrganizationRemoval['detached'] = [];
  for (const workspace of workspaces) {
    detached.push({ workspaceId: workspace.id, result: await detachFromWorkspace(targetId, workspace.id) });
  }
  await prisma.organizationMember.deleteMany({ where: { organizationId, userId: targetId } });
  await logAuditEvent(actorId, 'REMOVE_ORGANIZATION_MEMBER', 'USER', targetId, `Removed from organization ${organizationId}`);
  return { organizationId, userId: targetId, detached };
};
