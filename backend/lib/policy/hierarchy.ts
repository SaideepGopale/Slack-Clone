import { HttpError } from '../httpError';

/**
 * Company hierarchy (Stage 1, T.19). Pure functions, like the rest of
 * lib/policy; the caller's facts are loaded by context.ts#loadHierarchyActor.
 *
 *   COMPANY_ADMIN  the existing platform admin (User.role = ADMIN). Read only —
 *                  the frozen admin authentication is not changed or reused here.
 *   TEAM_LEAD      AccountTierGrant.tier = TEAM_LEAD.
 *   MEMBER         everyone else (no grant row, or tier = MEMBER). Deny by default.
 *
 * What the hierarchy decides — and nothing more:
 *  - who may CREATE workspaces and organizations (Company Admin, Team Lead);
 *  - who may HOLD an elevated workspace/organization role (ADMIN), so an
 *    ordinary Member can never be handed invite/add/manage powers.
 * It grants no content access and no management of anything a user does not
 * already own or belong to: those stay with lib/policy's workspace,
 * organization and channel rules (a Team Lead is an ordinary member
 * everywhere they are not owner/admin). Inactive accounts get nothing.
 */

export type HierarchyRole = 'COMPANY_ADMIN' | 'TEAM_LEAD' | 'MEMBER';
export type AccountTierName = 'TEAM_LEAD' | 'MEMBER';

export interface HierarchyActor {
  userId: string;
  role: HierarchyRole;
  // User.status === 'ACTIVE'. Suspended/banned accounts may still hold an
  // older session token (A2, frozen), so the hierarchy never trusts it alone.
  active: boolean;
}

export const hierarchyRoleOf = (account: { platformRole: string; tier: AccountTierName | null }): HierarchyRole => {
  if (account.platformRole === 'ADMIN') return 'COMPANY_ADMIN';
  return account.tier === 'TEAM_LEAD' ? 'TEAM_LEAD' : 'MEMBER';
};

const isLeadOrAdmin = (actor: HierarchyActor) => actor.active && (actor.role === 'COMPANY_ADMIN' || actor.role === 'TEAM_LEAD');

/** Creating a workspace (with or without an organization): Company Admins and Team Leads only. */
export const canCreateWorkspaces = (actor: HierarchyActor) => isLeadOrAdmin(actor);

/** Creating an organization: Company Admins and Team Leads only. */
export const canCreateOrganizations = (actor: HierarchyActor) => isLeadOrAdmin(actor);

/**
 * Whether an account may be GIVEN an elevated workspace/organization role
 * (ADMIN). Members never — an admin role carries invitations, direct adds,
 * join-request approval and member management. Demotions are never limited.
 */
export const canHoldElevatedRoles = (actor: HierarchyActor) => isLeadOrAdmin(actor);

export const assertCanCreateWorkspace = (actor: HierarchyActor) => {
  if (!canCreateWorkspaces(actor)) throw new HttpError(403, 'Only Team Leads can create workspaces.');
};

export const assertCanCreateOrganization = (actor: HierarchyActor) => {
  if (!canCreateOrganizations(actor)) throw new HttpError(403, 'Only Team Leads can create organizations.');
};

export const assertCanHoldElevatedRole = (target: HierarchyActor, scope: 'workspace' | 'organization') => {
  if (!canHoldElevatedRoles(target)) {
    throw new HttpError(403, `Only Team Leads can be made ${scope} admins. Ordinary members cannot hold admin roles.`);
  }
};
