import type { Workspace, WorkspaceMember } from '../types';
import type { InvitationState, OrganizationDetails, OrganizationMember, OrganizationSummary, OrganizationWorkspace, WorkspaceSettings } from './api';

/**
 * What the organization/workspace administration UI OFFERS (F2). Pure and
 * framework-free so it is unit-tested on its own and kept out of presentation
 * components.
 *
 * These mirror backend/lib/policy only to hide controls that would certainly
 * fail. They are never the authority: every request is re-checked by the
 * server, and a 403/404 from it is always shown to the user. When the server
 * computes a capability (settings/list `capabilities`) that value wins.
 */

export const NAME_MAX = 80; // workspaces.service.ts / organizations.service.ts
export const DESCRIPTION_MAX = 500; // workspaces.service.ts DESCRIPTION_MAX

const isManagerRole = (role: string | null | undefined) => role === 'OWNER' || role === 'ADMIN';

export interface WorkspaceAdminAccess {
  /** A workspace member (or anyone, for the Default Workspace). */
  isMember: boolean;
  /** Organization OWNER/ADMIN: manages the workspace, never reads its content. */
  isOrganizationManager: boolean;
  canEditSettings: boolean;
  canChangeRoles: boolean;
  canRemoveMembers: boolean;
  canManageInvitations: boolean;
  canDelete: boolean;
  canLeave: boolean;
}

/**
 * @param settings  GET /api/workspaces/:id/settings (server capabilities)
 * @param listEntry the caller's GET /api/workspaces entry, when they're a member
 */
export const workspaceAdminAccess = (settings: WorkspaceSettings, listEntry?: Workspace | null): WorkspaceAdminAccess => {
  const caps = settings.capabilities;
  const isOrganizationManager = isManagerRole(settings.organizationRole);
  const isMember = settings.myRole !== null || settings.isDefault;
  return {
    isMember,
    isOrganizationManager,
    canEditSettings: caps.canUpdateSettings,
    canChangeRoles: caps.canChangeRoles,
    canRemoveMembers: caps.canRemoveMembers,
    // Server: workspace.manageInvitations and workspace.updateSettings are the
    // same rule (canManageWorkspace). Prefer the list's explicit capability.
    canManageInvitations: listEntry?.capabilities?.canManageInvitations ?? caps.canUpdateSettings,
    // Server: workspace.delete = workspace OWNER or organization OWNER/ADMIN,
    // never the Default Workspace.
    canDelete: listEntry?.capabilities?.canDelete ?? (!settings.isDefault && (settings.myRole === 'OWNER' || isOrganizationManager)),
    // The owner deletes instead; nobody leaves the Default Workspace.
    canLeave: !settings.isDefault && settings.myRole !== null && settings.myRole !== 'OWNER',
  };
};

export type MemberRoleLabel = 'Owner' | 'Admin' | 'Member';

export const workspaceMemberRole = (member: Pick<WorkspaceMember, 'role' | 'isOwner'>): 'OWNER' | 'ADMIN' | 'MEMBER' =>
  member.isOwner ? 'OWNER' : member.role;

/** lib/policy canChangeWorkspaceRole: never the owner, never yourself. */
export const canChangeWorkspaceMemberRole = (access: WorkspaceAdminAccess, member: WorkspaceMember, viewerId: string | undefined) =>
  access.canChangeRoles && !member.isOwner && member.id !== viewerId;

/** lib/policy canRemoveWorkspaceMember: never the owner or yourself; admins only by the owner or organization managers. */
export const canRemoveWorkspaceMember = (
  access: WorkspaceAdminAccess,
  settings: Pick<WorkspaceSettings, 'myRole'>,
  member: WorkspaceMember,
  viewerId: string | undefined
) => {
  if (!access.canRemoveMembers || member.isOwner || member.id === viewerId) return false;
  if (member.role === 'ADMIN') return settings.myRole === 'OWNER' || access.isOrganizationManager;
  return true;
};

/** lib/policy canChangeOrganizationRole: explicit OWNER only; never the owner or yourself. */
export const canChangeOrganizationMemberRole = (
  organization: Pick<OrganizationSummary, 'capabilities'>,
  member: OrganizationMember,
  viewerId: string | undefined
) => organization.capabilities.canChangeRoles && member.id !== viewerId && member.role !== 'OWNER';

/** lib/policy canRemoveOrganizationMember (the server additionally refuses workspace owners). */
export const canRemoveOrganizationMember = (
  organization: Pick<OrganizationSummary, 'capabilities' | 'myRole' | 'isDefault'>,
  member: OrganizationMember,
  viewerId: string | undefined
) => {
  if (organization.isDefault || !organization.capabilities.canRemoveMembers) return false;
  if (member.id === viewerId || member.role === 'OWNER') return false;
  if (member.role === 'ADMIN') return organization.myRole === 'OWNER';
  return true;
};

/**
 * How an organization page may reach one of its workspaces.
 *  - open:   only members (content stays behind workspace membership);
 *  - manage: members see (read-only for plain members) settings; organization
 *            managers manage every workspace without becoming members.
 */
export const organizationWorkspaceActions = (organization: Pick<OrganizationDetails, 'capabilities'>, workspace: OrganizationWorkspace) => ({
  canOpen: workspace.isMember,
  canManage: workspace.isMember || organization.capabilities.canUpdate,
});

export const organizationRoleLabel = (role: string | null | undefined): MemberRoleLabel =>
  role === 'OWNER' ? 'Owner' : role === 'ADMIN' ? 'Admin' : 'Member';

export const INVITATION_STATE_LABEL: Record<InvitationState, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  expired: 'Expired',
  revoked: 'Revoked',
};

export const INVITATION_STATE_TONE: Record<InvitationState, 'warning' | 'success' | 'neutral' | 'danger'> = {
  pending: 'warning',
  accepted: 'success',
  expired: 'neutral',
  revoked: 'danger',
};

/** Groups the caller's workspaces by organization for the switcher (Default first, then server order). */
export const groupWorkspacesByOrganization = (workspaces: Workspace[]) => {
  const groups: { key: string; name: string | null; isDefault: boolean; workspaces: Workspace[] }[] = [];
  for (const workspace of workspaces) {
    const key = workspace.organization?.id ?? `none:${workspace.id}`;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, name: workspace.organization?.name ?? null, isDefault: !!workspace.organization?.isDefault || !!workspace.isDefault, workspaces: [] };
      groups.push(group);
    }
    group.workspaces.push(workspace);
  }
  return groups.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
};

/**
 * P2: the workspace rail's groups — the shared SmartConnect Collab first, then
 * the workspaces I own, then the ones shared with me. Empty groups are omitted.
 */
export type WorkspaceAccessGroupKey = 'collab' | 'mine' | 'shared';
export const WORKSPACE_ACCESS_GROUPS: Record<WorkspaceAccessGroupKey, { label: string; short: string }> = {
  collab: { label: 'SmartConnect Collab', short: 'Collab' },
  mine: { label: 'My workspaces', short: 'Mine' },
  shared: { label: 'Shared with me', short: 'Shared' },
};

export const groupWorkspacesByAccess = (workspaces: Workspace[]) => {
  const keyOf = (w: Workspace): WorkspaceAccessGroupKey => (w.isDefault ? 'collab' : w.isOwner ? 'mine' : 'shared');
  return (['collab', 'mine', 'shared'] as const)
    .map((key) => ({ key, ...WORKSPACE_ACCESS_GROUPS[key], workspaces: workspaces.filter((w) => keyOf(w) === key) }))
    .filter((group) => group.workspaces.length > 0);
};

export const formatDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
