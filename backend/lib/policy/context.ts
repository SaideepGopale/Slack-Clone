import { HttpError } from '../httpError';
import { isUuid } from '../messageInput';
import { prisma } from '../prisma';
import { ChannelActor, toChannelActor } from './channel';
import { AccountTierName, HierarchyActor, hierarchyRoleOf } from './hierarchy';
import {
  OrganizationActor,
  OrganizationRoleName,
  ProjectActor,
  projectAllowsChannelAccess,
  toProjectActor,
  WorkspaceActor,
  WorkspaceRoleName,
} from './policy';

/**
 * Resolves a caller's effective roles for the policy functions. One query
 * each; no authorization decisions are made here.
 */

const HIERARCHY_SELECT = { id: true, role: true, status: true, accountTier: { select: { tier: true } } } as const;

const toHierarchyActor = (account: { id: string; role: string; status: string; accountTier: { tier: AccountTierName } | null }): HierarchyActor => ({
  userId: account.id,
  role: hierarchyRoleOf({ platformRole: account.role, tier: account.accountTier?.tier ?? null }),
  active: account.status === 'ACTIVE',
});

/**
 * Company hierarchy (Stage 1): platform role (read only), status and tier,
 * straight from the database on every call — never from the session token,
 * so a downgrade or suspension applies to the very next request. An unknown
 * account resolves to an inactive MEMBER (no powers).
 */
export const loadHierarchyActor = async (userId: string): Promise<HierarchyActor> => {
  const account = await prisma.user.findUnique({ where: { id: userId }, select: HIERARCHY_SELECT });
  return account ? toHierarchyActor(account) : { userId, role: 'MEMBER', active: false };
};

/** Batch form for several accounts; unknown ids are simply absent from the result. */
export const loadHierarchyActors = async (userIds: string[]): Promise<HierarchyActor[]> =>
  userIds.length === 0
    ? []
    : (await prisma.user.findMany({ where: { id: { in: userIds } }, select: HIERARCHY_SELECT })).map(toHierarchyActor);

/**
 * Organization role resolution:
 *  1. an explicit OrganizationMember row wins;
 *  2. otherwise, belonging to any workspace of the organization implies MEMBER;
 *  3. otherwise, the Default Organization implies MEMBER for every account
 *     (frozen signup only creates Default Workspace memberships).
 */
export const loadOrganizationActor = async (userId: string, organizationId: string): Promise<OrganizationActor> => {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      isDefault: true,
      members: { where: { userId }, select: { role: true } },
      workspaces: { where: { members: { some: { userId } } }, select: { id: true }, take: 1 },
    },
  });
  if (!organization) throw new HttpError(404, 'Organization not found.');

  const explicit = organization.members[0]?.role as OrganizationRoleName | undefined;
  if (explicit) {
    return { userId, organizationId, isDefaultOrganization: organization.isDefault, role: explicit, implicit: false };
  }
  const implied = organization.workspaces.length > 0 || organization.isDefault;
  return {
    userId,
    organizationId,
    isDefaultOrganization: organization.isDefault,
    role: implied ? 'MEMBER' : null,
    implicit: implied,
  };
};

export const loadWorkspaceActor = async (userId: string, workspaceId: string): Promise<WorkspaceActor> => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      ownerId: true,
      isDefault: true,
      organizationId: true,
      channelCreationPolicy: true,
      members: { where: { userId }, select: { role: true } },
      organization: { select: { members: { where: { userId }, select: { role: true } } } },
    },
  });
  if (!workspace) throw new HttpError(404, 'Workspace not found.');

  const membership = workspace.members[0];
  let workspaceRole: WorkspaceRoleName | null = null;
  // Ownership (Workspace.ownerId) always resolves to OWNER for management;
  // reading content still requires channel membership elsewhere.
  if (workspace.ownerId === userId) workspaceRole = 'OWNER';
  else if (membership) workspaceRole = membership.role;
  else if (workspace.isDefault) workspaceRole = 'MEMBER'; // Default Workspace: implicit access

  return {
    userId,
    workspaceId,
    organizationId: workspace.organizationId,
    isDefaultWorkspace: workspace.isDefault,
    channelCreationPolicy: workspace.channelCreationPolicy,
    workspaceRole,
    organizationRole: (workspace.organization?.members[0]?.role as OrganizationRoleName | undefined) ?? null,
  };
};

/**
 * Project role + the workspace actor of the project's workspace. A missing
 * (or malformed) project id is a 404 — the same answer as a private project
 * the caller may not see, so ids can't be probed.
 */
export const loadProjectActor = async (
  userId: string,
  projectId: unknown
): Promise<ProjectActor & { workspaceId: string }> => {
  if (!isUuid(projectId)) throw new HttpError(404, 'Project not found.');
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      workspaceId: true,
      visibility: true,
      archivedAt: true,
      members: { where: { userId }, select: { role: true } },
    },
  });
  if (!project) throw new HttpError(404, 'Project not found.');
  const workspace = await loadWorkspaceActor(userId, project.workspaceId);
  return { ...toProjectActor(workspace, project, project.members[0]?.role ?? null), workspaceId: project.workspaceId };
};

/**
 * Channel role + context for lib/policy channel rules. A missing or malformed
 * id is a 404 — the same answer as a private channel the caller can't see.
 */
export const loadChannelActor = async (userId: string, channelId: unknown) => {
  if (!isUuid(channelId)) throw new HttpError(404, 'Channel not found.');
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      name: true,
      workspaceId: true,
      projectId: true,
      isDM: true,
      isGroupDM: true,
      visibility: true,
      isAnnouncement: true,
      archivedAt: true,
      members: { where: { userId }, select: { role: true } },
      project: { select: { visibility: true, members: { where: { userId }, select: { id: true } } } },
    },
  });
  if (!channel) throw new HttpError(404, 'Channel not found.');
  const workspace = await loadWorkspaceActor(userId, channel.workspaceId);
  const actor: ChannelActor = toChannelActor(
    workspace,
    channel,
    channel.members[0]?.role,
    projectAllowsChannelAccess(channel.project, (channel.project?.members.length ?? 0) > 0)
  );
  return { actor, channel };
};
