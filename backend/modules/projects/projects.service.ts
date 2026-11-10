import { Prisma } from '@prisma/client';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import {
  assertProject,
  assertWorkspace,
  canLeaveProject,
  canManageChannelPlacement,
  canManageWorkspace,
  CHANNEL_ARCHIVED_MESSAGE,
  canProject,
  canRemoveProjectMember,
  canTransferProjectOwnership,
  effectiveProjectRole,
  loadProjectActor,
  loadWorkspaceActor,
  PROJECT_ARCHIVED_MESSAGE,
  ProjectActor,
  ProjectRoleName,
  ProjectVisibilityName,
  toProjectActor,
  visibleProjectsWhere,
} from '../../lib/policy';
import { isGeneralChannel, lockChannelForPlacement, lockProjectForUpdate } from './projectGuards';
import { assertChannelNameAvailable } from '../channels/channelNames';
import {
  projectChannelView,
  projectMemberSelect,
  projectMemberView,
  ProjectMemberView,
  projectSummary,
  projectSummarySelect,
} from './projects.views';

/**
 * Project management (Batch 3 / Sub-batch C).
 *
 * Every decision goes through lib/policy (canProject / assertProject and the
 * target rules); this module only validates input, applies changes under the
 * row-lock protocol of projectGuards.ts and records audit entries. Real-time
 * fan-out lives in projects.realtime.ts and is triggered by the routes.
 */

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

// ---- input validation -------------------------------------------------------

const parseName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Project name is required.');
  const name = value.trim();
  if (name.length > NAME_MAX) throw new HttpError(400, `Project name must be ${NAME_MAX} characters or fewer.`);
  return name;
};

const parseDescription = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Project description must be text.');
  const description = value.trim();
  if (description.length > DESCRIPTION_MAX) {
    throw new HttpError(400, `Project description must be ${DESCRIPTION_MAX} characters or fewer.`);
  }
  return description || null;
};

const parseVisibility = (value: unknown): ProjectVisibilityName => {
  if (value === 'PUBLIC' || value === 'PRIVATE') return value;
  throw new HttpError(400, 'visibility must be PUBLIC or PRIVATE.');
};

const parseLimit = (value: unknown) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, PAGE_MAX) : PAGE_DEFAULT;
};

const parseSearch = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, NAME_MAX) : '');

const requireUserId = (value: unknown): string => {
  if (!isUuid(value)) throw new HttpError(400, 'Invalid user id.');
  return value;
};

const capabilities = (actor: ProjectActor) => ({
  canUpdate: canProject(actor, 'project.update'),
  canArchive: canProject(actor, 'project.archive'),
  canManageMembers: canProject(actor, 'project.manageMembers'),
  canTransferOwnership: canProject(actor, 'project.transferOwnership'),
  canManageChannels: canProject(actor, 'project.manageChannels'),
  canCreateChannel: canProject(actor, 'project.createChannel'),
  canJoin: canProject(actor, 'project.join') && effectiveProjectRole(actor) === null,
  canLeave: canLeaveProject(actor),
});

/** Locks the project for a write and refuses archived projects (re-checked under the lock). */
const lockActiveProject = async (tx: Prisma.TransactionClient, projectId: string) => {
  const locked = await lockProjectForUpdate(tx, projectId);
  if (!locked) throw new HttpError(404, 'Project not found.');
  if (locked.archived) throw new HttpError(409, PROJECT_ARCHIVED_MESSAGE);
  return locked;
};

// ---- read --------------------------------------------------------------------

/** Full project view for one caller (summary + owner + per-viewer role/capabilities). */
const projectDetail = async (actor: ProjectActor) => {
  const row = await prisma.project.findUnique({
    where: { id: actor.projectId },
    select: {
      ...projectSummarySelect,
      createdBy: { select: { id: true, username: true } },
      archivedBy: { select: { id: true, username: true } },
      members: { where: { role: 'OWNER' }, select: { user: { select: { id: true, username: true } } }, take: 1 },
    },
  });
  if (!row) throw new HttpError(404, 'Project not found.');
  return {
    ...projectSummary(row),
    owner: row.members[0]?.user ?? null,
    createdBy: row.createdBy,
    archivedBy: row.archivedBy,
    myRole: effectiveProjectRole(actor),
    capabilities: capabilities(actor),
  };
};

export type ProjectDetail = Awaited<ReturnType<typeof projectDetail>>;

/**
 * GET /api/workspaces/:workspaceId/projects?status=active|archived|all&q=&cursor=&limit=
 * Private projects appear only for their members and for managers. The SQL
 * scope mirrors the policy; every row is then re-checked with canProject.
 */
export const listProjects = async (userId: string, workspaceId: string, query: Record<string, unknown>) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const workspace = await loadWorkspaceActor(userId, workspaceId);
  assertWorkspace(workspace, 'workspace.viewProjects');

  const status = query.status ?? 'active';
  if (status !== 'active' && status !== 'archived' && status !== 'all') {
    throw new HttpError(400, 'status must be active, archived or all.');
  }
  const q = parseSearch(query.q);
  const limit = parseLimit(query.limit);
  const visible = visibleProjectsWhere(workspace);

  let cursor: string | undefined;
  if (query.cursor !== undefined) {
    // Only a project the caller can see may anchor a page — otherwise the
    // cursor's sort position would hint at a private project's name.
    const anchor = isUuid(query.cursor)
      ? await prisma.project.findFirst({ where: { AND: [visible, { id: query.cursor }] }, select: { id: true } })
      : null;
    if (!anchor) throw new HttpError(400, 'Invalid cursor.');
    cursor = anchor.id;
  }

  const rows = await prisma.project.findMany({
    where: {
      AND: [
        visible,
        status === 'active' ? { archivedAt: null } : status === 'archived' ? { archivedAt: { not: null } } : {},
        q ? { name: { contains: q, mode: 'insensitive' } } : {},
      ],
    },
    select: { ...projectSummarySelect, members: { where: { userId }, select: { role: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, limit);
  const projects = page.flatMap((row) => {
    const actor = toProjectActor(workspace, row, row.members[0]?.role ?? null);
    if (!canProject(actor, 'project.view')) return [];
    return [{ ...projectSummary(row), myRole: effectiveProjectRole(actor) }];
  });
  return { projects, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
};

/** GET /api/projects/:projectId */
export const getProject = async (userId: string, projectId: string) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.view');
  return projectDetail(actor);
};

/** GET /api/projects/:projectId/members?q=&cursor=&limit= — owner first, then by username. */
export const listProjectMembers = async (userId: string, projectId: string, query: Record<string, unknown>) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.view');
  const q = parseSearch(query.q);
  const limit = parseLimit(query.limit);

  let cursor: string | undefined;
  if (query.cursor !== undefined) {
    const anchor = isUuid(query.cursor)
      ? await prisma.projectMember.findFirst({ where: { id: query.cursor, projectId: actor.projectId }, select: { id: true } })
      : null;
    if (!anchor) throw new HttpError(400, 'Invalid cursor.');
    cursor = anchor.id;
  }

  const rows = await prisma.projectMember.findMany({
    where: { projectId: actor.projectId, ...(q ? { user: { username: { contains: q, mode: 'insensitive' } } } : {}) },
    select: projectMemberSelect,
    orderBy: [{ role: 'asc' }, { user: { username: 'asc' } }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return { members: page.map(projectMemberView), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
};

/** GET /api/projects/:projectId/channels — channel placement metadata (content still needs channel membership). */
export const listProjectChannels = async (userId: string, projectId: string) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.view');
  const channels = await prisma.channel.findMany({
    where: {
      projectId: actor.projectId,
      isDM: false,
      // Batch 3/D: private channels only for their members (and managers).
      ...(canManageWorkspace(actor.workspace) ? {} : { OR: [{ visibility: 'PUBLIC' }, { members: { some: { userId } } }] }),
    },
    select: {
      id: true,
      name: true,
      description: true,
      icon: true,
      visibility: true,
      isAnnouncement: true,
      archivedAt: true,
      createdAt: true,
      _count: { select: { members: true } },
      members: { where: { userId }, select: { id: true } },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return channels.map((c) => ({
    ...projectChannelView(c),
    visibility: c.visibility,
    isAnnouncement: c.isAnnouncement,
    archived: c.archivedAt !== null,
    createdAt: c.createdAt,
    memberCount: c._count.members,
    isMember: c.members.length > 0,
  }));
};

// ---- lifecycle -----------------------------------------------------------------

/** POST /api/workspaces/:workspaceId/projects { name, description?, visibility? } — creator becomes OWNER. */
export const createProject = async (userId: string, workspaceId: string, body: Record<string, unknown> | undefined) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const workspace = await loadWorkspaceActor(userId, workspaceId);
  assertWorkspace(workspace, 'workspace.createProject');
  const name = parseName(body?.name);
  const description = parseDescription(body?.description);
  const visibility = body?.visibility === undefined ? 'PUBLIC' : parseVisibility(body.visibility);

  // One statement: the project never exists without its owner.
  const project = await prisma.project.create({
    data: {
      workspaceId,
      name,
      description,
      visibility,
      createdById: userId,
      members: { create: { userId, role: 'OWNER' } },
    },
    select: { id: true },
  });
  await logAuditEvent(userId, 'CREATE_PROJECT', 'PROJECT', project.id, `Created ${visibility.toLowerCase()} project "${name}"`);
  return projectDetail(await loadProjectActor(userId, project.id));
};

/** PATCH /api/projects/:projectId { name?, description?, visibility? } */
export const updateProject = async (userId: string, projectId: string, body: Record<string, unknown> | undefined) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.update');

  const data: Prisma.ProjectUpdateInput = {};
  if (body?.name !== undefined) data.name = parseName(body.name);
  if (body?.description !== undefined) data.description = parseDescription(body.description);
  const visibility = body?.visibility !== undefined ? parseVisibility(body.visibility) : undefined;
  if (visibility) data.visibility = visibility;
  if (Object.keys(data).length === 0) throw new HttpError(400, 'Nothing to update.');

  const previousVisibility = await prisma.$transaction(async (tx) => {
    const locked = await lockActiveProject(tx, actor.projectId);
    if (visibility === 'PRIVATE' && locked.visibility === 'PUBLIC') {
      // A private project's channels may only contain project members. Making
      // the project private never silently removes anyone from a channel.
      const outsiders = await tx.user.count({
        where: {
          memberships: { some: { channel: { projectId: actor.projectId } } },
          projectMemberships: { none: { projectId: actor.projectId } },
        },
      });
      if (outsiders > 0) {
        throw new HttpError(
          409,
          `${outsiders} ${outsiders === 1 ? 'person is' : 'people are'} in this project's channels without being project members. ` +
            'Add them to the project (or remove them from those channels) before making it private.'
        );
      }
    }
    if (visibility === 'PUBLIC' && locked.visibility === 'PRIVATE') {
      // Batch 3/D: its public channels become visible to the whole workspace.
      const revealed = await tx.channel.findMany({
        where: { projectId: actor.projectId, visibility: 'PUBLIC', isDM: false },
        select: { id: true, name: true },
      });
      for (const channel of revealed) {
        await assertChannelNameAvailable(tx, actor.workspace, channel.name ?? '', channel.id);
      }
    }
    await tx.project.update({ where: { id: actor.projectId }, data });
    return locked.visibility;
  });

  const changes = Object.keys(data).join(', ');
  await logAuditEvent(userId, 'UPDATE_PROJECT', 'PROJECT', actor.projectId, `Updated project (${changes})`);
  return { project: await projectDetail(await loadProjectActor(userId, actor.projectId)), previousVisibility };
};

/** POST /api/projects/:projectId/archive | /restore — idempotent. */
export const setProjectArchived = async (userId: string, projectId: string, archived: boolean) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.archive');
  const result = await prisma.project.updateMany({
    where: { id: actor.projectId, archivedAt: archived ? null : { not: null } },
    data: archived ? { archivedAt: new Date(), archivedById: userId } : { archivedAt: null, archivedById: null },
  });
  const changed = result.count > 0;
  if (changed) {
    await logAuditEvent(userId, archived ? 'ARCHIVE_PROJECT' : 'RESTORE_PROJECT', 'PROJECT', actor.projectId,
      `${archived ? 'Archived' : 'Restored'} project`);
  }
  return { project: await projectDetail(await loadProjectActor(userId, actor.projectId)), changed };
};

// ---- membership ------------------------------------------------------------------

export interface ProjectMembershipEnded {
  projectId: string;
  workspaceId: string;
  userId: string;
  visibility: ProjectVisibilityName;
  // Channels of a PRIVATE project the user was removed from (rooms to revoke).
  channelIds: string[];
}

/**
 * Ends a MEMBER's project membership. For a PRIVATE project their channel
 * memberships inside it end too — they can no longer reach those channels,
 * and a stale row would otherwise keep listing them. For a PUBLIC project,
 * channel memberships stay (its channels are open to the whole workspace).
 */
const endProjectMembership = async (projectId: string, userId: string): Promise<ProjectMembershipEnded> =>
  prisma.$transaction(async (tx) => {
    const locked = await lockActiveProject(tx, projectId);
    // role MEMBER guards against a concurrent ownership transfer to this user.
    const deleted = await tx.projectMember.deleteMany({ where: { projectId, userId, role: 'MEMBER' } });
    if (deleted.count === 0) throw new HttpError(409, 'That membership changed in the meantime. Refresh and try again.');
    let channelIds: string[] = [];
    if (locked.visibility === 'PRIVATE') {
      const rows = await tx.channelMember.findMany({ where: { userId, channel: { projectId } }, select: { channelId: true } });
      channelIds = rows.map((r) => r.channelId);
      if (channelIds.length > 0) await tx.channelMember.deleteMany({ where: { userId, channelId: { in: channelIds } } });
    }
    return { projectId, workspaceId: locked.workspaceId, userId, visibility: locked.visibility, channelIds };
  });

/** POST /api/projects/:projectId/members { userId } — owner or managers. */
export const addProjectMember = async (actorId: string, projectId: string, targetIdInput: unknown) => {
  const actor = await loadProjectActor(actorId, projectId);
  assertProject(actor, 'project.manageMembers');
  const targetId = requireUserId(targetIdInput);

  // Same answer for "no such user" and "not in this workspace": no oracle.
  const [user, targetWorkspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: targetId }, select: { id: true } }),
    loadWorkspaceActor(targetId, actor.workspaceId),
  ]);
  if (!user || targetWorkspace.workspaceRole === null) {
    throw new HttpError(400, 'That user is not a member of this workspace.');
  }

  const member = await prisma.$transaction(async (tx) => {
    await lockActiveProject(tx, actor.projectId);
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: actor.projectId, userId: targetId } },
      select: { id: true },
    });
    if (existing) throw new HttpError(409, 'That person is already a member of this project.');
    return tx.projectMember.create({
      data: { projectId: actor.projectId, userId: targetId, role: 'MEMBER' },
      select: projectMemberSelect,
    });
  });
  await logAuditEvent(actorId, 'ADD_PROJECT_MEMBER', 'PROJECT', actor.projectId, `Added user ${targetId} to the project`);
  return { workspaceId: actor.workspaceId, member: projectMemberView(member) };
};

/** DELETE /api/projects/:projectId/members/:userId — owner or managers; never the owner, never yourself. */
export const removeProjectMember = async (actorId: string, projectId: string, targetIdInput: unknown) => {
  const actor = await loadProjectActor(actorId, projectId);
  assertProject(actor, 'project.manageMembers');
  const targetId = requireUserId(targetIdInput);
  if (targetId === actorId) throw new HttpError(400, 'Use "Leave project" to remove yourself.');

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: actor.projectId, userId: targetId } },
    select: { role: true },
  });
  if (!membership) throw new HttpError(404, 'That person is not a member of this project.');
  if (!canRemoveProjectMember(actor, { userId: targetId, role: membership.role })) {
    throw new HttpError(400, 'The project owner cannot be removed. Transfer ownership to another member first.');
  }

  const ended = await endProjectMembership(actor.projectId, targetId);
  await logAuditEvent(actorId, 'REMOVE_PROJECT_MEMBER', 'PROJECT', actor.projectId, `Removed user ${targetId} from the project`);
  return ended;
};

/** POST /api/projects/:projectId/leave — members only; the owner transfers ownership first. */
export const leaveProject = async (userId: string, projectId: string) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.view');
  const role = effectiveProjectRole(actor);
  if (role === null) throw new HttpError(404, 'You are not a member of this project.');
  if (actor.archived) throw new HttpError(409, PROJECT_ARCHIVED_MESSAGE);
  if (!canLeaveProject(actor)) {
    throw new HttpError(400, 'The project owner cannot leave. Transfer ownership to another member first.');
  }
  return endProjectMembership(actor.projectId, userId);
};

/** POST /api/projects/:projectId/join — public, active projects; idempotent. */
export const joinProject = async (userId: string, projectId: string) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.join');
  if (effectiveProjectRole(actor) !== null) {
    return { joined: false, workspaceId: actor.workspaceId, member: null, project: await projectDetail(actor) };
  }
  const member = await prisma.$transaction(async (tx) => {
    const locked = await lockActiveProject(tx, actor.projectId);
    // Became private in the meantime: answer exactly like an invisible project.
    if (locked.visibility !== 'PUBLIC') throw new HttpError(404, 'Project not found.');
    return tx.projectMember.upsert({
      where: { projectId_userId: { projectId: actor.projectId, userId } },
      update: {},
      create: { projectId: actor.projectId, userId, role: 'MEMBER' },
      select: projectMemberSelect,
    });
  });
  return {
    joined: true,
    workspaceId: actor.workspaceId,
    member: projectMemberView(member),
    project: await projectDetail(await loadProjectActor(userId, actor.projectId)),
  };
};

/**
 * PATCH /api/projects/:projectId/members/:userId { role }
 * There is exactly one OWNER, so the only real role change is an ownership
 * transfer: role OWNER on a MEMBER promotes them and demotes the previous
 * owner in one locked transaction. Demoting the owner directly is refused.
 */
export const changeProjectMemberRole = async (actorId: string, projectId: string, targetIdInput: unknown, roleInput: unknown) => {
  const actor = await loadProjectActor(actorId, projectId);
  if (roleInput !== 'OWNER' && roleInput !== 'MEMBER') throw new HttpError(400, 'role must be OWNER or MEMBER.');
  const role: ProjectRoleName = roleInput;
  assertProject(actor, 'project.transferOwnership');
  const targetId = requireUserId(targetIdInput);

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: actor.projectId, userId: targetId } },
    select: projectMemberSelect,
  });
  if (!membership) throw new HttpError(404, 'That person is not a member of this project.');
  if (membership.role === role) {
    return { workspaceId: actor.workspaceId, changed: [] as ProjectMemberView[], member: projectMemberView(membership) };
  }
  if (role === 'MEMBER') {
    throw new HttpError(400, 'A project always has exactly one owner. Make another member the owner instead.');
  }
  if (!canTransferProjectOwnership(actor, { userId: targetId, role: membership.role })) {
    throw new HttpError(403, 'Only the project owner or workspace admins can transfer project ownership.');
  }
  const targetWorkspace = await loadWorkspaceActor(targetId, actor.workspaceId);
  if (targetWorkspace.workspaceRole === null) throw new HttpError(400, 'That user is not a member of this workspace.');

  const changed = await prisma.$transaction(async (tx) => {
    await lockActiveProject(tx, actor.projectId);
    const current = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: actor.projectId, userId: targetId } },
      select: { id: true, role: true },
    });
    if (!current || current.role !== 'MEMBER') {
      throw new HttpError(409, 'That membership changed in the meantime. Refresh and try again.');
    }
    const previousOwners = await tx.projectMember.findMany({
      where: { projectId: actor.projectId, role: 'OWNER' },
      select: { id: true },
    });
    await tx.projectMember.updateMany({ where: { projectId: actor.projectId, role: 'OWNER' }, data: { role: 'MEMBER' } });
    await tx.projectMember.update({ where: { id: current.id }, data: { role: 'OWNER' } });
    return tx.projectMember.findMany({
      where: { id: { in: [current.id, ...previousOwners.map((o) => o.id)] } },
      select: projectMemberSelect,
    });
  });
  await logAuditEvent(actorId, 'TRANSFER_PROJECT_OWNERSHIP', 'PROJECT', actor.projectId, `Transferred project ownership to user ${targetId}`);
  const views = changed.map(projectMemberView);
  return { workspaceId: actor.workspaceId, changed: views, member: views.find((m) => m.userId === targetId)! };
};

// ---- channel placement --------------------------------------------------------------

const loadChannelForPlacement = async (actor: ProjectActor & { workspaceId: string }, channelId: unknown) => {
  if (!isUuid(channelId)) throw new HttpError(404, 'Channel not found.');
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      name: true,
      description: true,
      icon: true,
      workspaceId: true,
      isDM: true,
      projectId: true,
      visibility: true,
      archivedAt: true,
      members: { where: { userId: actor.userId }, select: { role: true } },
    },
  });
  // A channel of another workspace is indistinguishable from a missing one.
  if (!channel || channel.workspaceId !== actor.workspaceId) throw new HttpError(404, 'Channel not found.');
  // Batch 3/D: a private channel the caller can't see is indistinguishable too.
  if (channel.visibility === 'PRIVATE' && channel.members.length === 0 && !canManageWorkspace(actor.workspace)) {
    throw new HttpError(404, 'Channel not found.');
  }
  if (!canManageChannelPlacement(actor.workspace, channel.members[0]?.role ?? null)) {
    throw new HttpError(403, 'Only the channel owner or workspace admins can move this channel.');
  }
  return channel;
};

export interface ChannelPlacementResult {
  projectId: string;
  workspaceId: string;
  channel: ReturnType<typeof projectChannelView>;
  moved: boolean;
  // Batch 3/D: a PRIVATE channel's placement is announced to its own members only.
  visibility: 'PUBLIC' | 'PRIVATE';
}

/**
 * POST /api/projects/:projectId/channels { channelId } — moves an existing
 * channel into the project. Channel id and memberships are never changed.
 */
export const attachChannelToProject = async (actorId: string, projectId: string, channelId: unknown): Promise<ChannelPlacementResult> => {
  const actor = await loadProjectActor(actorId, projectId);
  assertProject(actor, 'project.manageChannels');
  const channel = await loadChannelForPlacement(actor, channelId);
  if (channel.isDM) throw new HttpError(400, 'Direct messages and group conversations can never belong to a project.');
  if (isGeneralChannel(channel)) throw new HttpError(400, 'The General channel always stays at workspace level.');
  if (channel.archivedAt) throw new HttpError(409, CHANNEL_ARCHIVED_MESSAGE);
  const result = {
    projectId: actor.projectId,
    workspaceId: actor.workspaceId,
    channel: projectChannelView(channel),
    visibility: channel.visibility,
  };
  if (channel.projectId === actor.projectId) return { ...result, moved: false };
  if (channel.projectId) {
    throw new HttpError(409, 'This channel already belongs to another project. Move it back to the workspace first.');
  }

  const moved = await prisma.$transaction(async (tx) => {
    // Lock order: channel, then project (see projectGuards.ts).
    const lockedChannel = await lockChannelForPlacement(tx, channel.id);
    if (!lockedChannel) throw new HttpError(404, 'Channel not found.');
    if (lockedChannel.projectId === actor.projectId) return false;
    if (lockedChannel.projectId) {
      throw new HttpError(409, 'This channel already belongs to another project. Move it back to the workspace first.');
    }
    const lockedProject = await lockActiveProject(tx, actor.projectId);
    if (lockedProject.visibility === 'PRIVATE') {
      const outsiders = await tx.user.count({
        where: {
          memberships: { some: { channelId: channel.id } },
          projectMemberships: { none: { projectId: actor.projectId } },
        },
      });
      if (outsiders > 0) {
        throw new HttpError(
          409,
          `${outsiders} ${outsiders === 1 ? 'member' : 'members'} of this channel ${outsiders === 1 ? 'is' : 'are'} not in this private project. ` +
            'Add them to the project first — moving a channel never changes its memberships.'
        );
      }
    }
    await tx.channel.update({ where: { id: channel.id }, data: { projectId: actor.projectId } });
    return true;
  });
  if (moved) {
    await logAuditEvent(actorId, 'MOVE_CHANNEL_TO_PROJECT', 'CHANNEL', channel.id, `Moved #${channel.name ?? channel.id} into project ${actor.projectId}`);
  }
  return { ...result, moved };
};

/** DELETE /api/projects/:projectId/channels/:channelId — moves the channel back to workspace level. */
export const detachChannelFromProject = async (actorId: string, projectId: string, channelId: unknown): Promise<ChannelPlacementResult> => {
  const actor = await loadProjectActor(actorId, projectId);
  assertProject(actor, 'project.manageChannels');
  const channel = await loadChannelForPlacement(actor, channelId);
  if (channel.projectId !== actor.projectId) throw new HttpError(404, 'That channel is not part of this project.');
  if (channel.archivedAt) throw new HttpError(409, CHANNEL_ARCHIVED_MESSAGE);

  await prisma.$transaction(async (tx) => {
    const lockedChannel = await lockChannelForPlacement(tx, channel.id);
    if (!lockedChannel || lockedChannel.projectId !== actor.projectId) {
      throw new HttpError(404, 'That channel is not part of this project.');
    }
    const lockedProject = await lockActiveProject(tx, actor.projectId);
    // Batch 3/D: leaving a private project makes a public channel visible to
    // the whole workspace — re-check its name (privacy-aware, channelNames.ts).
    if (lockedProject.visibility === 'PRIVATE' && lockedChannel.visibility === 'PUBLIC') {
      await assertChannelNameAvailable(tx, actor.workspace, channel.name ?? '', channel.id);
    }
    await tx.channel.update({ where: { id: channel.id }, data: { projectId: null } });
  });
  await logAuditEvent(actorId, 'MOVE_CHANNEL_TO_WORKSPACE', 'CHANNEL', channel.id, `Moved #${channel.name ?? channel.id} out of project ${actor.projectId}`);
  return {
    projectId: actor.projectId,
    workspaceId: actor.workspaceId,
    channel: projectChannelView(channel),
    moved: true,
    visibility: channel.visibility,
  };
};

/**
 * Channel creation inside a project (POST /api/channels { projectId }): the
 * project must belong to the same workspace and the caller must be allowed
 * 'project.createChannel'. A project of another workspace answers 404.
 */
export const assertCanCreateChannelInProject = async (userId: string, workspaceId: unknown, projectId: unknown) => {
  const actor = await loadProjectActor(userId, projectId);
  if (actor.workspaceId !== workspaceId) throw new HttpError(404, 'Project not found.');
  assertProject(actor, 'project.createChannel');
  return actor.projectId;
};
