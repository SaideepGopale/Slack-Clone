import { http, seg } from './http';

/**
 * Workspace invitations, invite links and join requests (Batch 3/E,
 * lib/policy 'workspace.manageInvitations'). Per-email invitation TOKENS are
 * never surfaced: the manager list endpoint doesn't return them, and the
 * create response's token is dropped here before it reaches any component.
 */

export type InvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface WorkspaceInvitation {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  state: InvitationState;
  inviter: { id: string; username: string } | null;
}

export interface JoinRequest {
  id: string;
  createdAt: string;
  user: { id: string; username: string; email: string };
}

export interface InviteResult {
  id: string;
  /** False when the invitation exists but the e-mail couldn't be delivered. */
  emailSent: boolean;
}

/** GET /api/workspaces/:id/invitations — newest first, state computed server-side, no tokens. */
export const listWorkspaceInvitations = (workspaceId: string) =>
  http.get<WorkspaceInvitation[]>(`/api/workspaces/${seg(workspaceId)}/invitations`);

/** POST /api/workspaces/:id/invites { email } */
export const inviteByEmail = async (workspaceId: string, email: string): Promise<InviteResult> => {
  const body = await http.post<{ id: string; token?: string; emailError?: string }>(`/api/workspaces/${seg(workspaceId)}/invites`, { email });
  // Deliberately NOT returning body.token (single-use credential) or the raw
  // provider error text.
  return { id: body.id, emailSent: !body.emailError };
};

export const revokeInvitation = (workspaceId: string, invitationId: string) =>
  http.delete<{ id: string; state: 'revoked' }>(`/api/workspaces/${seg(workspaceId)}/invitations/${seg(invitationId)}`);

/** GET …/invite-link — reuses or creates the shareable join link (joining still needs approval). */
export const getInviteLink = (workspaceId: string) =>
  http.get<{ url: string; expiresAt: string }>(`/api/workspaces/${seg(workspaceId)}/invite-link`);

/** DELETE …/invite-link — revokes every active link; a new one can be generated afterwards. */
export const revokeInviteLinks = (workspaceId: string) => http.delete<{ revoked: number }>(`/api/workspaces/${seg(workspaceId)}/invite-link`);

export const listJoinRequests = async (workspaceId: string): Promise<JoinRequest[]> => {
  const rows = await http.get<(JoinRequest & Record<string, unknown>)[]>(`/api/workspaces/${seg(workspaceId)}/requests`);
  return rows.map(({ id, createdAt, user }) => ({ id, createdAt, user }));
};

export const resolveJoinRequest = (workspaceId: string, requestId: string, action: 'APPROVE' | 'REJECT') =>
  http.put<{ status: 'APPROVED' | 'REJECTED' }>(`/api/workspaces/${seg(workspaceId)}/requests/${seg(requestId)}`, { action });
