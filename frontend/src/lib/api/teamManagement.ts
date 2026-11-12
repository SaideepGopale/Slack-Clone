import { http, seg } from './http';

/**
 * Stage 2 (T.20) — Company Admin → Team Lead provisioning and one-time
 * account activation. Authorization is enforced by the server; these are
 * typed wrappers only. One-time credentials are returned by `addTeamLead` /
 * `reissueInvitation` exactly once and must never be stored client-side.
 */

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
export type TeamLeadAccountStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED';

export interface TeamLeadInvitation {
  id: string;
  status: InvitationStatus;
  teamLabel: string | null;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  revokedReason: 'ADMIN' | 'TEAM_LEAD' | 'TOO_MANY_ATTEMPTS' | 'REISSUED' | null;
}

export interface TeamLead {
  id: string;
  username: string;
  loginId: string;
  displayName: string | null;
  status: TeamLeadAccountStatus;
  createdAt: string;
  invitation: TeamLeadInvitation | null;
}

export interface OneTimeCredentials {
  loginId: string;
  temporaryPassword: string;
  activationUrl: string;
  expiresAt: string;
}

export interface ProvisionResult {
  teamLead: TeamLead;
  credentials: OneTimeCredentials;
}

export interface NewTeamLead {
  email: string;
  displayName?: string;
  teamLabel?: string;
}

export const listTeamLeads = () => http.get<{ teamLeads: TeamLead[] }>('/api/team-management/team-leads');

export const addTeamLead = (body: NewTeamLead) => http.post<ProvisionResult>('/api/team-management/team-leads', body);

export const revokeInvitation = (invitationId: string) =>
  http.post<{ invitation: TeamLeadInvitation }>(`/api/team-management/invitations/${seg(invitationId)}/revoke`);

export const reissueInvitation = (userId: string) => http.post<ProvisionResult>(`/api/team-management/team-leads/${seg(userId)}/reissue`);

/** Public, one-time. Issues no session — the person signs in normally afterwards. */
export const activateAccount = (body: { token: string; temporaryPassword: string; newPassword: string }) =>
  http.post<{ activated: true; loginId: string }>('/api/account-activation', body);

// ---- Stage 3 (T.22): Team Lead → Member provisioning and hierarchy hints ----

export type HierarchyRole = 'COMPANY_ADMIN' | 'TEAM_LEAD' | 'MEMBER';
export interface Hierarchy {
  role: HierarchyRole;
  canCreateWorkspaces: boolean;
  canProvisionMembers: boolean;
}
/** UI hints only — every action is enforced by the server. */
export const myHierarchy = () => http.get<Hierarchy>('/api/me/hierarchy');

export interface MemberInvitation extends TeamLeadInvitation {
  account: { id: string; username: string; loginId: string; displayName: string | null; status: TeamLeadAccountStatus };
}
export interface MemberProvisionResult {
  invitation: MemberInvitation;
  credentials: OneTimeCredentials;
}
/** 409 bodies from addTeamMember (read from ApiError.data). */
export interface MemberProvisionConflict {
  error: string;
  existingAccount?: boolean;
  pendingActivation?: boolean;
  alreadyMember?: boolean;
  user?: { id: string; username: string; displayName: string | null };
}

const memberInvitations = (workspaceId: string) => `/api/workspaces/${seg(workspaceId)}/member-invitations`;

export const listMemberInvitations = (workspaceId: string) => http.get<{ invitations: MemberInvitation[] }>(memberInvitations(workspaceId));

export const addTeamMember = (workspaceId: string, body: { email: string; displayName?: string }) =>
  http.post<MemberProvisionResult>(memberInvitations(workspaceId), body);

export const revokeMemberInvitation = (workspaceId: string, invitationId: string) =>
  http.post<{ invitation: MemberInvitation }>(`${memberInvitations(workspaceId)}/${seg(invitationId)}/revoke`);

export const reissueMemberInvitation = (workspaceId: string, invitationId: string) =>
  http.post<MemberProvisionResult>(`${memberInvitations(workspaceId)}/${seg(invitationId)}/reissue`);
