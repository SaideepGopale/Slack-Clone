import { Prisma } from '@prisma/client';
import { HttpError } from '../../lib/httpError';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import { SYSTEM_USER_EMAIL } from '../../lib/sharedWorkspace';

/**
 * Stage 4 (T.23) — Company Admin workspace overview. READ-ONLY metadata:
 * counts, names, roles, statuses and dates. Every query selects explicit
 * fields; nothing here reads message content, files, attachments, threads,
 * DMs, calls, password hashes, token hashes or temporary passwords, and
 * nothing grants membership or content access. Each endpoint runs a fixed
 * number of queries (no per-row queries).
 */

const SYSTEM_EMAILS = [SYSTEM_USER_EMAIL, 'deleted-user@system.internal'];
const notSystem = { email: { notIn: SYSTEM_EMAILS } } satisfies Prisma.UserWhereInput;
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const SCAN_LIMIT = 10_000; // workspaces considered per list request (see T.23 remaining issues)

const text = (value: unknown, max = 100) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const intParam = (value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'Invalid pagination or filter value.');
  return n;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new HttpError(400, 'Invalid filter or sort value.');
  return value as T;
};
const page = (query: Record<string, unknown>) => {
  const pageNumber = intParam(query.page, { min: 1, max: 100_000, fallback: 1 });
  const pageSize = intParam(query.pageSize, { min: 1, max: PAGE_SIZE_MAX, fallback: PAGE_SIZE_DEFAULT });
  return { pageNumber, pageSize };
};
const now = () => new Date();
const pendingWhere = () => ({ status: 'PENDING' as const, expiresAt: { gt: now() } });

const PERSON = { id: true, username: true, email: true, status: true, role: true, createdAt: true, profile: { select: { displayName: true } }, accountTier: { select: { tier: true } } } as const;
type PersonRow = Prisma.UserGetPayload<{ select: typeof PERSON }>;
const levelOf = (p: Pick<PersonRow, 'role' | 'accountTier'>) => (p.role === 'ADMIN' ? 'COMPANY_ADMIN' : p.accountTier?.tier === 'TEAM_LEAD' ? 'TEAM_LEAD' : 'MEMBER');
const person = (p: PersonRow) => ({
  id: p.id,
  username: p.username,
  displayName: p.profile?.displayName ?? null,
  email: p.email, // Company Admin only (they already see logins in User Management)
  status: p.status,
  level: levelOf(p),
});

/** GET /api/company-overview/summary */
export const companySummary = async () => {
  const at = now();
  const [totalWorkspaces, activeWorkspaces, users, leads, invitations, expired] = await Promise.all([
    prisma.workspace.count(),
    prisma.workspace.count({ where: { members: { some: { user: { status: 'ACTIVE', ...notSystem } } } } }),
    // Team Members: ordinary accounts that are not Team Leads (no tier row, or MEMBER).
    prisma.user.groupBy({ by: ['status'], where: { ...notSystem, role: 'USER', NOT: { accountTier: { is: { tier: 'TEAM_LEAD' } } } }, _count: { _all: true } }),
    prisma.accountTierGrant.count({ where: { tier: 'TEAM_LEAD', user: notSystem } }),
    prisma.accountInvitation.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.accountInvitation.count({ where: { status: 'PENDING', expiresAt: { lte: at } } }),
  ]);
  const [activeUsers, suspendedUsers] = await Promise.all([
    prisma.user.count({ where: { ...notSystem, status: 'ACTIVE' } }),
    prisma.user.count({ where: { ...notSystem, status: 'SUSPENDED' } }),
  ]);
  const byStatus = (status: string) => users.find((u) => u.status === status)?._count._all ?? 0;
  const invites = (status: string) => invitations.find((i) => i.status === status)?._count._all ?? 0;
  const teamMembers = users.reduce((sum, u) => sum + u._count._all, 0);
  return {
    totalWorkspaces,
    activeWorkspaces,
    totalActiveUsers: activeUsers,
    totalTeamLeads: leads,
    totalTeamMembers: teamMembers,
    activeMembers: byStatus('ACTIVE'),
    suspendedMembers: byStatus('SUSPENDED'),
    suspendedUsers,
    invitations: {
      pending: invites('PENDING') - expired,
      accepted: invites('ACCEPTED'),
      expired,
      revoked: invites('REVOKED'),
    },
  };
};

const WORKSPACE_SORTS = ['name', 'createdAt', 'members'] as const;

/** GET /api/company-overview/workspaces — search, filter, sort, paginate. */
export const listCompanyWorkspaces = async (query: Record<string, unknown>) => {
  const q = text(query.q);
  const teamLeadId = query.teamLeadId === undefined || query.teamLeadId === '' ? null : query.teamLeadId;
  if (teamLeadId !== null && !isUuid(teamLeadId)) throw new HttpError(400, 'Invalid filter or sort value.');
  const status = oneOf(query.status, ['all', 'active', 'inactive'] as const, 'all');
  const type = oneOf(query.type, ['all', 'default', 'team'] as const, 'all');
  const minMembers = intParam(query.minMembers, { min: 0, max: 1_000_000, fallback: 0 });
  const maxMembers = intParam(query.maxMembers, { min: 0, max: 1_000_000, fallback: 1_000_000 });
  const sort = oneOf(query.sort, WORKSPACE_SORTS, 'createdAt');
  const order = oneOf(query.order, ['asc', 'desc'] as const, sort === 'name' ? 'asc' : 'desc');
  const { pageNumber, pageSize } = page(query);

  // Parameterized Prisma filters (no string-built SQL).
  const where: Prisma.WorkspaceWhereInput = {
    ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] } : {}),
    ...(type === 'default' ? { isDefault: true } : type === 'team' ? { isDefault: false } : {}),
    ...(teamLeadId ? { ownerId: teamLeadId as string } : {}),
  };
  const rows = await prisma.workspace.findMany({
    where,
    select: {
      id: true,
      name: true,
      description: true,
      isDefault: true,
      createdAt: true,
      owner: { select: PERSON },
      _count: { select: { members: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: SCAN_LIMIT,
  });
  const ids = rows.map((w) => w.id);
  const [active, pending] = await Promise.all([
    prisma.workspaceMember.groupBy({ by: ['workspaceId'], where: { workspaceId: { in: ids }, user: { status: 'ACTIVE', ...notSystem } }, _count: { _all: true } }),
    prisma.accountInvitation.groupBy({ by: ['workspaceId'], where: { workspaceId: { in: ids }, ...pendingWhere() }, _count: { _all: true } }),
  ]);
  const activeBy = new Map(active.map((a) => [a.workspaceId, a._count._all]));
  const pendingBy = new Map(pending.map((p) => [p.workspaceId, p._count._all]));

  let items = rows.map((w) => {
    const owner = person(w.owner);
    const activeMembers = activeBy.get(w.id) ?? 0;
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      type: w.isDefault ? ('default' as const) : ('team' as const),
      isDefault: w.isDefault,
      owner,
      teamLead: owner.level === 'TEAM_LEAD' ? { id: owner.id, username: owner.username, displayName: owner.displayName } : null,
      memberCount: w._count.members,
      activeMemberCount: activeMembers,
      pendingInvitations: pendingBy.get(w.id) ?? 0,
      status: activeMembers > 0 ? ('active' as const) : ('inactive' as const),
      createdAt: w.createdAt,
    };
  });
  items = items.filter((w) => (status === 'all' || w.status === status) && w.memberCount >= minMembers && w.memberCount <= maxMembers);
  const dir = order === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    // The shared default workspace stays on top of the default (date) ordering.
    if (sort === 'createdAt' && a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const delta =
      sort === 'name' ? a.name.localeCompare(b.name) : sort === 'members' ? a.memberCount - b.memberCount : a.createdAt.getTime() - b.createdAt.getTime();
    return delta * dir || a.id.localeCompare(b.id);
  });
  const total = items.length;
  return {
    workspaces: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    page: pageNumber,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

/** GET /api/company-overview/workspaces/:id — read-only administrative detail. */
export const companyWorkspaceDetail = async (workspaceId: unknown) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      description: true,
      isDefault: true,
      createdAt: true,
      channelCreationPolicy: true,
      owner: { select: PERSON },
      organization: { select: { id: true, name: true, isDefault: true } },
    },
  });
  if (!workspace) throw new HttpError(404, 'Workspace not found.');
  const [members, memberTotal, invitations, channels, lastMessage] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId, user: notSystem },
      select: { role: true, createdAt: true, user: { select: PERSON } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    }),
    prisma.workspaceMember.count({ where: { workspaceId } }),
    prisma.accountInvitation.findMany({
      where: { workspaceId, status: 'PENDING', expiresAt: { gt: now() } },
      // Explicit: never tokenHash, tempPasswordHash or credentialFingerprint.
      select: { id: true, createdAt: true, expiresAt: true, user: { select: { id: true, username: true, email: true, profile: { select: { displayName: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.channel.groupBy({ by: ['visibility'], where: { workspaceId, isDM: false, archivedAt: null }, _count: { _all: true } }),
    // Timestamp only — never content.
    prisma.message.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  const owner = person(workspace.owner);
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    type: workspace.isDefault ? 'default' : 'team',
    isDefault: workspace.isDefault,
    createdAt: workspace.createdAt,
    channelCreationPolicy: workspace.channelCreationPolicy,
    organization: workspace.organization,
    owner,
    teamLead: owner.level === 'TEAM_LEAD' ? { id: owner.id, username: owner.username, displayName: owner.displayName } : null,
    memberCount: memberTotal,
    members: members.map((m) => ({
      ...person(m.user),
      workspaceRole: m.user.id === workspace.owner.id ? 'OWNER' : m.role,
      joinedAt: m.createdAt,
    })),
    pendingInvitations: invitations.map((i) => ({
      id: i.id,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      account: { id: i.user.id, username: i.user.username, displayName: i.user.profile?.displayName ?? null, email: i.user.email },
    })),
    activity: {
      publicChannels: channels.find((c) => c.visibility === 'PUBLIC')?._count._all ?? 0,
      privateChannels: channels.find((c) => c.visibility === 'PRIVATE')?._count._all ?? 0,
      lastMessageAt: lastMessage?.createdAt ?? null,
    },
  };
};

/** GET /api/company-overview/team-leads — search + paginate. */
export const listCompanyTeamLeads = async (query: Record<string, unknown>) => {
  const q = text(query.q);
  const { pageNumber, pageSize } = page(query);
  const where: Prisma.UserWhereInput = {
    ...notSystem,
    accountTier: { is: { tier: 'TEAM_LEAD' } },
    ...(q
      ? { OR: [{ username: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { profile: { is: { displayName: { contains: q, mode: 'insensitive' } } } }] }
      : {}),
  };
  const [total, leads] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: PERSON, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (pageNumber - 1) * pageSize, take: pageSize }),
  ]);
  const ids = leads.map((l) => l.id);
  const [owned, pending, memberCounts] = await Promise.all([
    prisma.workspace.groupBy({ by: ['ownerId'], where: { ownerId: { in: ids }, isDefault: false }, _count: { _all: true } }),
    prisma.accountInvitation.groupBy({ by: ['createdById'], where: { createdById: { in: ids }, ...pendingWhere() }, _count: { _all: true } }),
    ids.length === 0
      ? Promise.resolve([] as { ownerId: string; members: bigint }[])
      : // Distinct people (other than the lead) across the lead's own team workspaces. Parameterized.
        prisma.$queryRaw<{ ownerId: string; members: bigint }[]>`
          SELECT w."ownerId", COUNT(DISTINCT m."userId") AS members
          FROM "Workspace" w JOIN "WorkspaceMember" m ON m."workspaceId" = w.id
          WHERE w."ownerId" IN (${Prisma.join(ids)}) AND w."isDefault" = false AND m."userId" <> w."ownerId"
          GROUP BY w."ownerId"`,
  ]);
  const ownedBy = new Map(owned.map((o) => [o.ownerId, o._count._all]));
  const pendingBy = new Map(pending.map((p) => [p.createdById, p._count._all]));
  const membersBy = new Map(memberCounts.map((m) => [m.ownerId, Number(m.members)]));
  return {
    teamLeads: leads.map((lead) => ({
      ...person(lead),
      createdAt: lead.createdAt,
      managedWorkspaces: ownedBy.get(lead.id) ?? 0,
      teamMembers: membersBy.get(lead.id) ?? 0,
      pendingInvitations: pendingBy.get(lead.id) ?? 0,
    })),
    page: pageNumber,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};
