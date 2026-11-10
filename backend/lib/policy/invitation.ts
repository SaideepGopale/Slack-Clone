/**
 * Invitation and join-request rules (Batch 3 / Sub-batch E). Pure functions,
 * like the rest of lib/policy. Who may *manage* invitations is the workspace
 * action 'workspace.manageInvitations'; this file decides whether a given
 * invitation may be accepted and whether an account may join at all.
 */

/**
 * Invitations had no expiry (audit DB-07). Without a schema change, an
 * invitation is valid for this long after it was created.
 */
export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export const invitationState = (invitation: { status: string; createdAt: Date }, now = Date.now()): InvitationState => {
  if (invitation.status === 'accepted') return 'accepted';
  if (invitation.status !== 'pending') return 'revoked'; // 'revoked' and any unknown legacy value
  return now - invitation.createdAt.getTime() >= INVITATION_TTL_MS ? 'expired' : 'pending';
};

export const invitationExpiresAt = (invitation: { createdAt: Date }) => new Date(invitation.createdAt.getTime() + INVITATION_TTL_MS);

/** Invitation addresses are compared case-insensitively (audit DB-04). */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export type InvitationDenial = 'used' | 'revoked' | 'expired' | 'inviterLostAccess' | 'wrongAccount' | 'inactiveAccount';

export interface InvitationAcceptance {
  state: InvitationState;
  inviteeEmail: string;
  accountEmail: string;
  accountActive: boolean;
  // The inviter must STILL be allowed to manage invitations for the
  // workspace: an admin who was removed or demoted can't keep letting people
  // in through invitations they sent earlier.
  inviterCanManage: boolean;
}

/** null = may accept. The invitation only ever grants plain MEMBER — never a client-chosen role. */
export const invitationAcceptanceDenial = (ctx: InvitationAcceptance): InvitationDenial | null => {
  if (ctx.state === 'accepted') return 'used';
  if (ctx.state === 'revoked') return 'revoked';
  if (ctx.state === 'expired') return 'expired';
  if (!ctx.inviterCanManage) return 'inviterLostAccess';
  if (normalizeEmail(ctx.inviteeEmail) !== normalizeEmail(ctx.accountEmail)) return 'wrongAccount';
  if (!ctx.accountActive) return 'inactiveAccount';
  return null;
};

/** Suspended or banned accounts can't join workspaces (request, accept, or be approved). */
export const canJoinWorkspaces = (account: { status: string }) => account.status === 'ACTIVE';
