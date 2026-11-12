import { logAuditEvent } from '../../lib/auditLog';
import { userIdsByEmail } from '../../lib/identity';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import { ChannelAccess } from '../../sockets/channelAccess';
import { getPresenceInWorkspace, getPresenceMapInWorkspace } from '../../sockets/presence.handlers';
import {
  assertCanHoldElevatedRole,
  assertWorkspace,
  canChangeWorkspaceRole,
  canJoinWorkspaces,
  canSeeWorkspaceMemberEmails,
  canRemoveWorkspaceMember,
  DirectoryViewer,
  isGeneralChannelName,
  loadHierarchyActor,
  loadWorkspaceActor,
  projectChannelAccessWhere,
  visibleEmail,
} from '../../lib/policy';
import { SYSTEM_USER_EMAIL } from '../../lib/sharedWorkspace';
import { Prisma } from '@prisma/client';
import { emitToWorkspace } from '../../sockets/registry';
import { assertCanLeaveChannel } from '../channels/channelManagement.service';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Workspace People directory, profiles, and membership removal (Batch 2).
 * Callers are already verified as workspace members by requireWorkspaceAccess
 * (or channel members by requireChannelMembership).
 */

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

const isGeneralChannel = (channel: { name: string | null; isDM: boolean }) =>
  !channel.isDM && isGeneralChannelName(channel.name);

// P1-D (FA-SEC-03): e-mails, and searching by e-mail, only for viewers who may
// see them (lib/policy canSeeWorkspaceMemberEmails) — everyone sees their own.
export const listMembers = async (
  viewer: DirectoryViewer,
  workspaceId: string,
  query: { q?: unknown; cursor?: unknown; limit?: unknown }
) => {
  const take = Math.min(Math.max(Number(query.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const cursor = isUuid(query.cursor) ? query.cursor : undefined;

  const [workspace, rows] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } }),
    prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        ...(q
          ? {
              user: {
                OR: [
                  { username: { contains: q, mode: 'insensitive' as const } },
                  { profile: { displayName: { contains: q, mode: 'insensitive' as const } } },
                  ...(viewer.canSeeEmails ? [{ email: { contains: q, mode: 'insensitive' as const } }] : []),
                ],
              },
            }
          : {}),
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, username: true, email: true, profile: { select: { title: true, displayName: true } } } },
      },
      orderBy: [{ user: { username: 'asc' } }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  ]);

  const page = rows.slice(0, take);
  const presence = await getPresenceMapInWorkspace(page.map((m) => m.user.id), workspaceId);
  return {
    members: page.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      email: visibleEmail(viewer, m.user),
      displayName: m.user.profile?.displayName ?? null,
      title: m.user.profile?.title ?? null,
      role: m.role,
      isOwner: workspace?.ownerId === m.user.id,
      joinedAt: m.createdAt,
      presence: presence.get(m.user.id) ?? null,
    })),
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
  };
};

export const getMemberProfile = async (viewer: DirectoryViewer, workspaceId: string, userId: string) => {
  if (!isUuid(userId)) throw new HttpError(400, 'Invalid user id.');
  const membership = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: {
      role: true,
      createdAt: true,
      workspace: { select: { ownerId: true } },
      user: { select: { id: true, username: true, email: true, profile: true } },
    },
  });
  if (!membership) throw new HttpError(404, 'This person is not a member of this workspace.');

  const sharedChannels = await prisma.channel.findMany({
    where: {
      workspaceId,
      isDM: false,
      AND: [{ members: { some: { userId } } }, { members: { some: { userId: viewer.id } } }],
      // Batch 3/C: never list a private project's channel to a non-member viewer.
      ...projectChannelAccessWhere(viewer.id),
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 20,
  });

  const profile = membership.user.profile;
  return {
    id: membership.user.id,
    username: membership.user.username,
    email: visibleEmail(viewer, membership.user),
    role: membership.role,
    isOwner: membership.workspace.ownerId === userId,
    joinedAt: membership.createdAt,
    displayName: profile?.displayName ?? null,
    title: profile?.title ?? null,
    bio: profile?.bio ?? null,
    timezone: profile?.timezone ?? null,
    presence: await getPresenceInWorkspace(userId, workspaceId),
    sharedChannels,
  };
};

// ---- Direct membership (P2) -------------------------------------------------
// A workspace manager (lib/policy 'workspace.manageInvitations': workspace
// OWNER/ADMIN or organization OWNER/ADMIN; never the shared workspace) adds an
// existing registered account straight to the workspace — no e-mail, no link.

const RESERVED_LOGINS = [SYSTEM_USER_EMAIL, 'deleted-user@system.internal'];

/** GET /api/workspaces/:workspaceId/member-candidates?q= — active accounts not yet in the workspace. */
export const searchMemberCandidates = async (actorId: string, workspaceId: string, query: { q?: unknown }) => {
  assertWorkspace(await loadWorkspaceActor(actorId, workspaceId), 'workspace.manageInvitations');
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  if (!q) return { users: [] };
  // Stage 6C (IDN-3): the exact login, in any letter case — never a pattern ("_", "%", "\" are ordinary characters).
  const exactLogin = await userIdsByEmail(prisma, q);
  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      email: { notIn: RESERVED_LOGINS },
      workspaces: { none: { workspaceId } },
      OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { profile: { displayName: { contains: q, mode: 'insensitive' } } },
        // An exact login only — never an e-mail substring search (FA-SEC-03).
        { id: { in: exactLogin } },
      ],
    },
    select: { id: true, username: true, profile: { select: { displayName: true } } },
    orderBy: { username: 'asc' },
    take: 20,
  });
  return { users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.profile?.displayName ?? null })) };
};

/** POST /api/workspaces/:workspaceId/members { userId } — add as MEMBER (+ General) in one transaction. */
export const addWorkspaceMember = async (actorId: string, workspaceId: string, userId: unknown) => {
  const actor = await loadWorkspaceActor(actorId, workspaceId);
  assertWorkspace(actor, 'workspace.manageInvitations');
  if (!isUuid(userId)) throw new HttpError(400, 'Choose a registered user to add.');
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true, status: true, profile: { select: { displayName: true, title: true } } },
  });
  if (!target || RESERVED_LOGINS.includes(target.email)) throw new HttpError(404, 'User not found.');
  if (!canJoinWorkspaces(target)) throw new HttpError(409, 'That account is not active and cannot join this workspace.');
  const general = await prisma.channel.findFirst({
    where: { workspaceId, isDM: false, name: { equals: 'General', mode: 'insensitive' } },
    select: { id: true },
  });
  if (!general) throw new HttpError(500, 'This workspace has no "General" channel to add the user to.');

  let joinedAt: Date;
  try {
    joinedAt = await prisma.$transaction(async (tx) => {
      const member = await tx.workspaceMember.create({ data: { userId: target.id, workspaceId, role: 'MEMBER' }, select: { createdAt: true } });
      await tx.channelMember.upsert({
        where: { userId_channelId: { userId: target.id, channelId: general.id } },
        update: {},
        create: { userId: target.id, channelId: general.id, role: 'member' },
      });
      return member.createdAt;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, `${target.username} is already a member of this workspace.`);
    }
    throw err;
  }
  await logAuditEvent(actorId, 'ADD_WORKSPACE_MEMBER', 'WORKSPACE', workspaceId, `Added ${target.username} to the workspace`);
  return {
    userId: target.id,
    generalChannelId: general.id,
    member: {
      id: target.id,
      username: target.username,
      displayName: target.profile?.displayName ?? null,
      email: visibleEmail({ id: actorId, canSeeEmails: canSeeWorkspaceMemberEmails(actor) }, target),
      title: target.profile?.title ?? null,
      role: 'MEMBER' as const,
      isOwner: false,
      joinedAt,
      presence: await getPresenceInWorkspace(target.id, workspaceId),
    },
  };
};

export interface DetachResult {
  // Every channel/DM room of this workspace the user was in (all revoked).
  channelIds: string[];
  // Group DMs the user was removed from (remaining participants are notified).
  groupDMIds: string[];
  // Batch 3/C: projects of this workspace the user belonged to (memberships
  // ended with the workspace membership; project audiences are notified).
  projectIds: string[];
}

/**
 * Removes a user from a workspace in one transaction: their WorkspaceMember
 * row plus their memberships in the workspace's public channels and group
 * DMs. 1:1 DM rows are kept so the other participant's history stays intact
 * — access to them is still denied, because every content check requires
 * workspace membership (getChannelAccess).
 */
export const detachFromWorkspace = async (userId: string, workspaceId: string): Promise<DetachResult> => {
  const channels = await prisma.channel.findMany({
    where: { workspaceId, members: { some: { userId } } },
    select: { id: true, isDM: true, isGroupDM: true },
  });
  const detachable = channels.filter((c) => !c.isDM || c.isGroupDM).map((c) => c.id);
  const projects = await prisma.projectMember.findMany({
    where: { userId, project: { workspaceId } },
    select: { projectId: true },
  });
  await prisma.$transaction([
    prisma.channelMember.deleteMany({ where: { userId, channelId: { in: detachable } } }),
    // Project roles are only meaningful inside the workspace (lib/policy also
    // ignores a stale row). A departing project OWNER leaves the project
    // ownerless; workspace/organization managers can assign a new owner.
    prisma.projectMember.deleteMany({ where: { userId, project: { workspaceId } } }),
    prisma.workspaceMember.delete({ where: { userId_workspaceId: { userId, workspaceId } } }),
  ]);
  return {
    channelIds: channels.map((c) => c.id),
    groupDMIds: channels.filter((c) => c.isGroupDM).map((c) => c.id),
    projectIds: projects.map((p) => p.projectId),
  };
};

const loadWorkspaceForMembershipChange = async (workspaceId: string) => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, ownerId: true, isDefault: true },
  });
  if (!workspace) throw new HttpError(404, 'Workspace not found');
  // Every account can open the Default Workspace (requireWorkspaceAccess
  // bypass), so removing a membership row there would not revoke anything.
  if (workspace.isDefault) {
    throw new HttpError(400, 'Membership of the default workspace cannot be changed — every account can access it.');
  }
  return workspace;
};

export const removeWorkspaceMember = async (actorId: string, workspaceId: string, targetId: string) => {
  if (!isUuid(targetId)) throw new HttpError(400, 'Invalid user id.');
  const workspace = await loadWorkspaceForMembershipChange(workspaceId);
  if (targetId === actorId) throw new HttpError(400, 'Use "Leave workspace" to remove yourself.');

  // Batch 3/E: lib/policy decides (workspace owner/admins, and organization
  // OWNER/ADMINs who needn't be workspace members) — no inline role checks.
  const actor = await loadWorkspaceActor(actorId, workspaceId);
  assertWorkspace(actor, 'workspace.removeMember');
  const target = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId: targetId, workspaceId } },
    include: { user: { select: { username: true } } },
  });
  if (!target) throw new HttpError(404, 'This person is not a member of this workspace.');
  const targetRole = targetId === workspace.ownerId ? 'OWNER' : target.role;
  if (targetRole === 'OWNER') throw new HttpError(403, 'The workspace owner cannot be removed.');
  if (!canRemoveWorkspaceMember(actor, { userId: targetId, role: targetRole })) {
    throw new HttpError(403, 'Only the workspace owner or organization admins can remove an admin.');
  }

  const result = await detachFromWorkspace(targetId, workspaceId);
  await logAuditEvent(
    actorId,
    'REMOVE_WORKSPACE_MEMBER',
    'USER',
    targetId,
    `Removed "${target.user.username}" from workspace "${workspace.name}"`
  );
  return result;
};

export const leaveWorkspace = async (userId: string, workspaceId: string) => {
  const workspace = await loadWorkspaceForMembershipChange(workspaceId);
  if (workspace.ownerId === userId) {
    throw new HttpError(400, 'The owner cannot leave the workspace. Delete it or transfer ownership instead.');
  }
  const membership = await prisma.workspaceMember.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  if (!membership) throw new HttpError(404, 'You are not a member of this workspace.');
  return detachFromWorkspace(userId, workspaceId);
};

const assertRegularChannel = (access: ChannelAccess) => {
  if (access.isDM) throw new HttpError(400, 'Use the conversation participant controls for direct messages.');
  if (isGeneralChannel({ name: access.name, isDM: access.isDM })) {
    throw new HttpError(400, 'Everyone in the workspace stays in General.');
  }
};

export const leaveChannel = async (userId: string, access: ChannelAccess) => {
  assertRegularChannel(access);
  // Batch 3/D: the owner transfers ownership first unless nobody else is left.
  await assertCanLeaveChannel(userId, access.channelId);
  await prisma.channelMember.delete({ where: { userId_channelId: { userId, channelId: access.channelId } } });
};

// Channel member removal moved to channels/channelManagement.service.ts
// (Batch 3/D, lib/policy channel rules).

/**
 * Workspace role change (Batch 3/B): ADMIN ⇄ MEMBER. Decided by lib/policy —
 * the workspace owner or organization owners/admins; never the owner's own
 * role, never your own. Ownership transfer is not part of this endpoint.
 */
export const changeWorkspaceMemberRole = async (actorId: string, workspaceId: string, targetId: string, rawRole: unknown) => {
  if (!isUuid(targetId)) throw new HttpError(400, 'Invalid user id.');
  if (rawRole !== 'ADMIN' && rawRole !== 'MEMBER') throw new HttpError(400, 'role must be ADMIN or MEMBER.');
  const actor = await loadWorkspaceActor(actorId, workspaceId);
  const target = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId: targetId, workspaceId } },
    select: { role: true, user: { select: { username: true } }, workspace: { select: { ownerId: true, name: true } } },
  });
  if (!target) throw new HttpError(404, 'This person is not a member of this workspace.');
  const targetRole = target.workspace.ownerId === targetId ? 'OWNER' : target.role;
  if (!canChangeWorkspaceRole(actor, { userId: targetId, role: targetRole })) {
    throw new HttpError(403, 'Only the workspace owner or organization admins can change roles (never the owner\'s or your own).');
  }
  // Stage 1 (T.19): a workspace ADMIN can invite, add and manage members, so
  // only Team Leads (or Company Admins) may be given it — explicit
  // authorization of a fellow lead by the owner. Demotion is never limited.
  if (rawRole === 'ADMIN') assertCanHoldElevatedRole(await loadHierarchyActor(targetId), 'workspace');
  await prisma.workspaceMember.update({
    where: { userId_workspaceId: { userId: targetId, workspaceId } },
    data: { role: rawRole },
  });
  await logAuditEvent(actorId, 'CHANGE_WORKSPACE_ROLE', 'USER', targetId, `"${target.user.username}" is now ${rawRole} in "${target.workspace.name}"`);
  const payload = { workspaceId, userId: targetId, role: rawRole };
  emitToWorkspace(workspaceId, 'workspace:member_updated', payload);
  return payload;
};

export { HttpError };
