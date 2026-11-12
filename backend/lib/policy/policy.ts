import { HttpError } from '../httpError';

/**
 * Centralized authorization policy (Batch 3).
 *
 * Pure functions over an "actor" — the caller's effective roles, resolved by
 * lib/policy/context.ts — so every rule is unit-testable without a database
 * and every module asks the same questions the same way.
 *
 * Role systems (deliberately separate, never conflated):
 *  - Organization: OWNER | ADMIN | MEMBER     (OrganizationMember.role)
 *  - Workspace:    OWNER (Workspace.ownerId) | ADMIN | MEMBER (WorkspaceMember.role)
 *  - Platform:     User.role — frozen admin authentication, NOT used here.
 *
 * Inheritance (decision 5): organization OWNER/ADMIN can *manage* every
 * workspace of their organization (settings, members, roles) without being a
 * member — but management never grants content access; reading channels and
 * messages still requires membership (sockets/channelAccess.ts).
 *
 * Sub-batch B covers organizations and workspaces; C adds projects. Channels
 * (D) extend this module; E moves the remaining legacy inline checks onto it.
 */

export type OrganizationRoleName = 'OWNER' | 'ADMIN' | 'MEMBER';
export type WorkspaceRoleName = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface OrganizationActor {
  userId: string;
  organizationId: string;
  isDefaultOrganization: boolean;
  // null = not a member at all.
  role: OrganizationRoleName | null;
  // true when the role is implied rather than stored (Default Organization,
  // or membership derived from belonging to one of its workspaces).
  implicit: boolean;
}

export interface WorkspaceActor {
  userId: string;
  workspaceId: string;
  organizationId: string | null;
  isDefaultWorkspace: boolean;
  channelCreationPolicy: 'MEMBERS' | 'ADMINS';
  // null = not a member (Default Workspace members are implicit MEMBERs).
  workspaceRole: WorkspaceRoleName | null;
  organizationRole: OrganizationRoleName | null;
}

export type OrganizationAction =
  | 'organization.view'
  | 'organization.viewMembers'
  | 'organization.update'
  | 'organization.createWorkspace'
  | 'organization.changeMemberRole'
  | 'organization.removeMember';

export type WorkspaceAction =
  | 'workspace.view'
  | 'workspace.viewSettings'
  | 'workspace.updateSettings'
  | 'workspace.changeMemberRole'
  | 'workspace.removeMember'
  | 'workspace.createChannel'
  | 'workspace.viewProjects'
  | 'workspace.createProject'
  // Sub-batch E: the remaining legacy inline checks, consolidated.
  | 'workspace.viewMembers'
  | 'workspace.manageInvitations' // email invitations, invite links, join requests
  | 'workspace.delete';

const isOrgManager = (role: OrganizationRoleName | null) => role === 'OWNER' || role === 'ADMIN';
const isWorkspaceManager = (role: WorkspaceRoleName | null) => role === 'OWNER' || role === 'ADMIN';

/** Workspace management power, including inheritance from the organization. */
export const canManageWorkspace = (actor: WorkspaceActor) =>
  isWorkspaceManager(actor.workspaceRole) || isOrgManager(actor.organizationRole);

export const canOrganization = (actor: OrganizationActor, action: OrganizationAction): boolean => {
  switch (action) {
    case 'organization.view':
    case 'organization.viewMembers':
      return actor.role !== null;
    case 'organization.update':
    case 'organization.createWorkspace':
    case 'organization.removeMember':
      return isOrgManager(actor.role) && !actor.implicit;
    case 'organization.changeMemberRole':
      return actor.role === 'OWNER' && !actor.implicit;
    default:
      return false;
  }
};

// P2: the shared workspace (SmartConnect Collab, isDefault) is platform-
// managed. Nobody changes its global configuration, roles or membership
// through workspace APIs: no renaming/settings, no role changes, no
// invitations (everyone already has access), no deletion.
const SHARED_WORKSPACE_LOCKED: ReadonlySet<WorkspaceAction> = new Set([
  'workspace.updateSettings',
  'workspace.changeMemberRole',
  'workspace.manageInvitations',
  'workspace.delete',
]);

export const canWorkspace = (actor: WorkspaceActor, action: WorkspaceAction): boolean => {
  if (actor.isDefaultWorkspace && SHARED_WORKSPACE_LOCKED.has(action)) return false;
  switch (action) {
    case 'workspace.view':
      return actor.workspaceRole !== null;
    case 'workspace.viewSettings':
      return actor.workspaceRole !== null || isOrgManager(actor.organizationRole);
    case 'workspace.updateSettings':
    case 'workspace.removeMember':
      return canManageWorkspace(actor);
    case 'workspace.changeMemberRole':
      // Promoting/demoting admins is an owner-level decision.
      return actor.workspaceRole === 'OWNER' || isOrgManager(actor.organizationRole);
    case 'workspace.createChannel':
      if (actor.workspaceRole === null) return false;
      return actor.channelCreationPolicy === 'MEMBERS' || canManageWorkspace(actor);
    case 'workspace.viewProjects':
      // Listing is filtered per project by canProject('project.view').
      return actor.workspaceRole !== null || isOrgManager(actor.organizationRole);
    case 'workspace.createProject':
      // Content-level: the creator becomes the project's OWNER, so they must
      // belong to the workspace (organization managers alone may not).
      return actor.workspaceRole !== null;
    case 'workspace.viewMembers':
      // The member directory is management data for organization managers too.
      return actor.workspaceRole !== null || isOrgManager(actor.organizationRole);
    case 'workspace.manageInvitations':
      // Who gets in is a management decision — previously WorkspaceMember
      // ADMIN only, now with organization inheritance (decision 5).
      return canManageWorkspace(actor);
    case 'workspace.delete':
      // Irreversible: owner-level only (workspace OWNER or organization
      // OWNER/ADMIN), the same level that may change admin roles. Workspace
      // ADMINs can't remove another admin, so they can't remove everyone.
      // The Default Workspace (every account's fallback) is never deletable.
      if (actor.isDefaultWorkspace) return false;
      return actor.workspaceRole === 'OWNER' || isOrgManager(actor.organizationRole);
    default:
      return false;
  }
};

const DENIAL_MESSAGES: Record<OrganizationAction | WorkspaceAction, string> = {
  'organization.view': 'You are not a member of this organization.',
  'organization.viewMembers': 'You are not a member of this organization.',
  'organization.update': 'Only organization owners and admins can change organization settings.',
  'organization.createWorkspace': 'Only organization owners and admins can create workspaces in this organization.',
  'organization.changeMemberRole': 'Only the organization owner can change organization roles.',
  'organization.removeMember': 'Only organization owners and admins can remove members.',
  'workspace.view': 'You are not a member of this workspace.',
  'workspace.viewSettings': 'You are not a member of this workspace.',
  'workspace.updateSettings': 'Only workspace owners and admins can change workspace settings.',
  'workspace.changeMemberRole': 'Only the workspace owner or organization admins can change workspace roles.',
  'workspace.removeMember': 'Only workspace admins can remove members.',
  'workspace.createChannel': 'Only workspace admins can create channels in this workspace.',
  'workspace.viewProjects': 'You are not a member of this workspace.',
  'workspace.createProject': 'Only workspace members can create projects in this workspace.',
  'workspace.viewMembers': 'You are not a member of this workspace.',
  'workspace.manageInvitations': 'Only workspace owners and admins can manage invitations and join requests.',
  'workspace.delete': 'Only the workspace owner or organization admins can delete this workspace.',
};

export const assertOrganization = (actor: OrganizationActor, action: OrganizationAction) => {
  if (!canOrganization(actor, action)) {
    throw new HttpError(actor.role === null ? 404 : 403, DENIAL_MESSAGES[action]);
  }
};

export const assertWorkspace = (actor: WorkspaceActor, action: WorkspaceAction) => {
  if (!canWorkspace(actor, action)) throw new HttpError(403, DENIAL_MESSAGES[action]);
};

// ---- Member e-mail visibility (P1-D, finding FA-SEC-03) --------------------
// Other people's e-mail addresses are management data. Directories return
// them only to the people who manage those members — the same people the F2
// admin panels show them to — and to each member for themselves. Everyone
// else, including every account's implicit membership of the Default
// Workspace/Organization, gets names only and no e-mail search.

/** Workspace directories: workspace OWNER/ADMIN, or organization OWNER/ADMIN by inheritance. */
export const canSeeWorkspaceMemberEmails = (actor: WorkspaceActor) => canManageWorkspace(actor);

/** Organization directory: explicit organization OWNER/ADMIN (never an implicit membership). */
export const canSeeOrganizationMemberEmails = (actor: OrganizationActor) => isOrgManager(actor.role) && !actor.implicit;

export interface DirectoryViewer {
  id: string;
  canSeeEmails: boolean;
}

/** A member's e-mail as this viewer may see it: always their own, others' only for managers. */
export const visibleEmail = (viewer: DirectoryViewer, member: { id: string; email: string }) =>
  viewer.canSeeEmails || viewer.id === member.id ? member.email : undefined;

// ---- Target-specific rules (who may change/remove whom) -------------------

export interface WorkspaceTarget {
  userId: string;
  role: WorkspaceRoleName; // OWNER when target is Workspace.ownerId
}

/**
 * Removal: managers may remove members; removing an admin needs owner-level
 * power (workspace owner or org manager); the owner is never removable;
 * self-removal goes through "leave".
 */
export const canRemoveWorkspaceMember = (actor: WorkspaceActor, target: WorkspaceTarget): boolean => {
  if (target.userId === actor.userId || target.role === 'OWNER') return false;
  if (!canWorkspace(actor, 'workspace.removeMember')) return false;
  if (target.role === 'ADMIN') return actor.workspaceRole === 'OWNER' || isOrgManager(actor.organizationRole);
  return true;
};

/** Role change: owner-level power; never on the owner; never on yourself. */
export const canChangeWorkspaceRole = (actor: WorkspaceActor, target: WorkspaceTarget): boolean =>
  target.userId !== actor.userId && target.role !== 'OWNER' && canWorkspace(actor, 'workspace.changeMemberRole');

export interface OrganizationTarget {
  userId: string;
  role: OrganizationRoleName;
}

export const canChangeOrganizationRole = (actor: OrganizationActor, target: OrganizationTarget): boolean =>
  target.userId !== actor.userId && target.role !== 'OWNER' && canOrganization(actor, 'organization.changeMemberRole');

export const canRemoveOrganizationMember = (actor: OrganizationActor, target: OrganizationTarget): boolean => {
  if (actor.isDefaultOrganization) return false; // implicit membership: nothing to revoke
  if (target.userId === actor.userId || target.role === 'OWNER') return false;
  if (!canOrganization(actor, 'organization.removeMember')) return false;
  if (target.role === 'ADMIN') return actor.role === 'OWNER';
  return true;
};

// ---- Projects (Sub-batch C) ------------------------------------------------
//
// Project roles: OWNER (exactly one per project, see projects.service.ts) and
// MEMBER. "Managers" are the workspace's managers as defined above
// (workspace OWNER/ADMIN, organization OWNER/ADMIN) — the same people who
// manage the workspace manage its projects; no parallel permission system.
//
//  - Visibility: PUBLIC → every workspace member; PRIVATE → project members,
//    plus managers for management metadata only. Channel *content* still
//    requires channel membership (sockets/channelAccess.ts), and channels of a
//    private project additionally require project membership.
//  - A project role only counts while the user still belongs to the workspace
//    (defense in depth against a stale ProjectMember row).
//  - Archived projects are read-only: everything except view and restore is
//    refused until the project is restored.

export type ProjectRoleName = 'OWNER' | 'MEMBER';
export type ProjectVisibilityName = 'PUBLIC' | 'PRIVATE';

export interface ProjectActor {
  userId: string;
  projectId: string;
  workspace: WorkspaceActor;
  visibility: ProjectVisibilityName;
  archived: boolean;
  // null = not a project member.
  projectRole: ProjectRoleName | null;
}

export type ProjectAction =
  | 'project.view'
  | 'project.update'
  | 'project.archive'
  | 'project.join'
  | 'project.manageMembers'
  | 'project.transferOwnership'
  | 'project.manageChannels'
  | 'project.createChannel';

/** Builds a ProjectActor from an already-resolved workspace actor (listings). */
export const toProjectActor = (
  workspace: WorkspaceActor,
  project: { id: string; visibility: ProjectVisibilityName; archivedAt: Date | null },
  projectRole: ProjectRoleName | null
): ProjectActor => ({
  userId: workspace.userId,
  projectId: project.id,
  workspace,
  visibility: project.visibility,
  archived: project.archivedAt !== null,
  projectRole,
});

/** The caller's project role, honoured only while they belong to the workspace. */
export const effectiveProjectRole = (actor: ProjectActor): ProjectRoleName | null =>
  actor.workspace.workspaceRole !== null ? actor.projectRole : null;

export const canProject = (actor: ProjectActor, action: ProjectAction): boolean => {
  const role = effectiveProjectRole(actor);
  const inWorkspace = actor.workspace.workspaceRole !== null;
  const manager = canManageWorkspace(actor.workspace);
  const ownerOrManager = role === 'OWNER' || manager;
  switch (action) {
    case 'project.view':
      return role !== null || manager || (actor.visibility === 'PUBLIC' && inWorkspace);
    case 'project.archive': // archive and restore
      return ownerOrManager;
    case 'project.update':
    case 'project.manageMembers':
    case 'project.transferOwnership':
    case 'project.manageChannels':
      return !actor.archived && ownerOrManager;
    case 'project.join':
      return !actor.archived && actor.visibility === 'PUBLIC' && inWorkspace;
    case 'project.createChannel':
      return !actor.archived && role !== null;
    default:
      return false;
  }
};

const PROJECT_DENIALS: Record<ProjectAction, string> = {
  'project.view': 'Project not found.',
  'project.update': 'Only the project owner or workspace admins can change this project.',
  'project.archive': 'Only the project owner or workspace admins can archive or restore this project.',
  'project.join': 'Only workspace members can join public projects. Ask the project owner to add you.',
  'project.manageMembers': 'Only the project owner or workspace admins can manage project members.',
  'project.transferOwnership': 'Only the project owner or workspace admins can transfer project ownership.',
  'project.manageChannels': 'Only the project owner or workspace admins can move channels into or out of this project.',
  'project.createChannel': 'Only project members can create channels in this project.',
};

export const PROJECT_ARCHIVED_MESSAGE = 'This project is archived. Restore it first.';

/**
 * 404 when the caller may not even see the project (private projects never
 * leak their existence), 409 when the only obstacle is the archived state,
 * 403 otherwise.
 */
export const assertProject = (actor: ProjectActor, action: ProjectAction) => {
  if (canProject(actor, action)) return;
  if (!canProject(actor, 'project.view')) throw new HttpError(404, PROJECT_DENIALS['project.view']);
  if (actor.archived && canProject({ ...actor, archived: false }, action)) {
    throw new HttpError(409, PROJECT_ARCHIVED_MESSAGE);
  }
  throw new HttpError(403, PROJECT_DENIALS[action]);
};

export interface ProjectTarget {
  userId: string;
  role: ProjectRoleName;
}

/** Removal: owner/managers remove members; never the owner (transfer first); never yourself (leave). */
export const canRemoveProjectMember = (actor: ProjectActor, target: ProjectTarget): boolean =>
  target.userId !== actor.userId && target.role !== 'OWNER' && canProject(actor, 'project.manageMembers');

/** Ownership moves only to an existing MEMBER; the previous owner becomes a MEMBER. */
export const canTransferProjectOwnership = (actor: ProjectActor, target: ProjectTarget): boolean =>
  target.role === 'MEMBER' && canProject(actor, 'project.transferOwnership');

/** Members may leave; the owner must transfer ownership first. */
export const canLeaveProject = (actor: ProjectActor): boolean =>
  !actor.archived && effectiveProjectRole(actor) === 'MEMBER';

/**
 * Moving a channel into or out of a project needs authority over the channel
 * as well as over the project: the channel's owner (legacy ChannelMember.role
 * 'admin', decision 3) or a workspace/organization manager.
 */
export const canManageChannelPlacement = (workspace: WorkspaceActor, channelRole: string | null): boolean =>
  (workspace.workspaceRole !== null && channelRole === 'admin') || canManageWorkspace(workspace);

/**
 * Channel-level consequence of project privacy: a channel inside a PRIVATE
 * project is reachable (listed, joined, read, subscribed) only by project
 * members — on top of the existing channel + workspace membership checks.
 * Managers get no content access through this (decision 5).
 */
export const projectAllowsChannelAccess = (
  project: { visibility: ProjectVisibilityName } | null,
  isProjectMember: boolean
): boolean => project === null || project.visibility === 'PUBLIC' || isProjectMember;
