import { Prisma } from '@prisma/client';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { findUserIdByEmail } from '../../lib/identity';
import { isUuid } from '../../lib/messageInput';
import { canCreateWorkspaces, canWorkspace, loadHierarchyActor, loadWorkspaceActor } from '../../lib/policy';
import { prisma } from '../../lib/prisma';
import {
  createInvitedAccount,
  credentialsResponse,
  DUPLICATE,
  INVITATION_SELECT,
  invitationView,
  parseEmail,
  parseOptionalText,
  reissueAccountInvitation,
  RESERVED_EMAILS,
} from './teamLeads.service';

/**
 * Stage 3 (T.22) — Team Lead → Member provisioning, reusing the Stage 2
 * account/invitation machinery (createInvitedAccount, reissueAccountInvitation,
 * the activation endpoint). A Member invitation creates an ordinary,
 * SUSPENDED account with no tier row (= MEMBER) and binds the Team Lead's
 * workspace; activation makes the account ACTIVE and joins that workspace
 * (activation.service). Nothing here can grant a tier, an admin role or a
 * workspace role above MEMBER — the request body is read for e-mail and
 * display name only.
 */

/** Only an active Team Lead who may invite to this (non-default) workspace. */
const assertCanProvisionMembers = async (actorId: string, workspaceId: unknown) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const hierarchy = await loadHierarchyActor(actorId);
  if (hierarchy.role !== 'TEAM_LEAD' || !hierarchy.active) throw new HttpError(403, 'Only Team Leads can add new team members.');
  const actor = await loadWorkspaceActor(actorId, workspaceId); // 404 when the workspace doesn't exist
  // manageInvitations: workspace owner/admin (or organization manager) — and
  // never SmartConnect Collab, which is locked for everyone.
  if (!canWorkspace(actor, 'workspace.manageInvitations')) throw new HttpError(403, 'You can only add members to workspaces you manage.');
  return workspaceId as string;
};

const MEMBER_INVITATION_SELECT = {
  ...INVITATION_SELECT,
  user: { select: { id: true, username: true, email: true, status: true, profile: { select: { displayName: true } } } },
} as const;
type MemberInvitationRow = Prisma.AccountInvitationGetPayload<{ select: typeof MEMBER_INVITATION_SELECT }>;

const toMemberInvitation = ({ user, ...invitation }: MemberInvitationRow) => ({
  ...invitation,
  status: invitationView(invitation),
  account: { id: user.id, username: user.username, loginId: user.email, displayName: user.profile?.displayName ?? null, status: user.status },
});

const loadMemberInvitation = async (id: string) =>
  toMemberInvitation(await prisma.accountInvitation.findUniqueOrThrow({ where: { id }, select: MEMBER_INVITATION_SELECT }));

export type ProvisionMemberResult =
  | { kind: 'created'; body: { invitation: ReturnType<typeof toMemberInvitation>; credentials: ReturnType<typeof credentialsResponse> } }
  | { kind: 'conflict'; body: Record<string, unknown> };

/** POST /api/workspaces/:workspaceId/member-invitations { email, displayName? } */
export const provisionMember = async (actorId: string, rawWorkspaceId: unknown, body: Record<string, unknown> | undefined): Promise<ProvisionMemberResult> => {
  const workspaceId = await assertCanProvisionMembers(actorId, rawWorkspaceId);
  const email = parseEmail(body?.email);
  const displayName = parseOptionalText(body?.displayName, 'Display name');
  if (RESERVED_EMAILS.includes(email)) throw new HttpError(409, DUPLICATE);

  // Stage 6C (IDN-3): the account holding exactly this address (any letter case) —
  // "_", "%" and "\" are ordinary characters, so no other person's account matches.
  const existingId = await findUserIdByEmail(prisma, email);
  const existing = !existingId ? null : await prisma.user.findUnique({
    where: { id: existingId },
    select: {
      id: true,
      username: true,
      status: true,
      profile: { select: { displayName: true } },
      accountInvitations: { select: { status: true } },
      workspaces: { where: { workspaceId }, select: { id: true } },
    },
  });
  if (existing) {
    // Never a second account. Tell the lead which existing-user path applies.
    if (existing.workspaces.length > 0) {
      return { kind: 'conflict', body: { error: 'This person is already a member of this workspace.', alreadyMember: true } };
    }
    const awaitingActivation = existing.accountInvitations.length > 0 && !existing.accountInvitations.some((i) => i.status === 'ACCEPTED');
    if (awaitingActivation) {
      return { kind: 'conflict', body: { error: 'This person already has an account invitation awaiting activation.', pendingActivation: true } };
    }
    return {
      kind: 'conflict',
      body: {
        error: 'This person already has an account. Invite them to the workspace instead.',
        existingAccount: true,
        user: { id: existing.id, username: existing.username, displayName: existing.profile?.displayName ?? null },
      },
    };
  }

  try {
    const { userId, username, issued } = await createInvitedAccount(actorId, { email, displayName, teamLabel: null, tier: 'MEMBER', workspaceId });
    const invitation = await prisma.accountInvitation.findFirstOrThrow({ where: { userId, status: 'PENDING' }, select: { id: true } });
    await logAuditEvent(actorId, 'PROVISION_MEMBER', 'USER', userId, `Provisioned member "${username}" (login ${email}) for workspace ${workspaceId}; invitation expires ${issued.expiresAt.toISOString()}`);
    return { kind: 'created', body: { invitation: await loadMemberInvitation(invitation.id), credentials: credentialsResponse(email, issued) } };
  } catch (err) {
    // Lost a race with a concurrent submit for the same address.
    if (err instanceof HttpError && err.status === 409) {
      return { kind: 'conflict', body: { error: 'This person already has an account invitation awaiting activation.', pendingActivation: true } };
    }
    throw err;
  }
};

/** GET /api/workspaces/:workspaceId/member-invitations — the latest invitation per provisioned account (no secrets). */
export const listMemberInvitations = async (actorId: string, rawWorkspaceId: unknown) => {
  const workspaceId = await assertCanProvisionMembers(actorId, rawWorkspaceId);
  const rows = await prisma.accountInvitation.findMany({
    where: { workspaceId, intendedTier: 'MEMBER' },
    select: MEMBER_INVITATION_SELECT,
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const seen = new Set<string>();
  const latest = rows.filter((row) => (seen.has(row.user.id) ? false : (seen.add(row.user.id), true)));
  return { invitations: latest.map(toMemberInvitation) };
};

const loadScopedInvitation = async (workspaceId: string, invitationId: unknown) => {
  if (!isUuid(invitationId)) throw new HttpError(404, 'Invitation not found.');
  const invitation = await prisma.accountInvitation.findUnique({
    where: { id: invitationId },
    select: { id: true, userId: true, workspaceId: true, intendedTier: true, user: { select: { username: true } } },
  });
  // Scoped: an invitation is only reachable through its own workspace's path.
  if (!invitation || invitation.workspaceId !== workspaceId || invitation.intendedTier !== 'MEMBER') throw new HttpError(404, 'Invitation not found.');
  return invitation;
};

/** POST /api/workspaces/:workspaceId/member-invitations/:invitationId/revoke */
export const revokeMemberInvitation = async (actorId: string, rawWorkspaceId: unknown, invitationId: unknown) => {
  const workspaceId = await assertCanProvisionMembers(actorId, rawWorkspaceId);
  const invitation = await loadScopedInvitation(workspaceId, invitationId);
  const revoked = await prisma.accountInvitation.updateMany({
    where: { id: invitation.id, status: 'PENDING' },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'TEAM_LEAD', tempPasswordHash: null },
  });
  if (revoked.count === 0) throw new HttpError(409, 'Only pending invitations can be revoked.');
  await logAuditEvent(actorId, 'REVOKE_ACCOUNT_INVITATION', 'USER', invitation.userId, `Revoked the activation invitation of "${invitation.user.username}" (workspace ${workspaceId})`);
  return { invitation: await loadMemberInvitation(invitation.id) };
};

/** POST /api/workspaces/:workspaceId/member-invitations/:invitationId/reissue — a fresh invitation, shown once. */
export const reissueMemberInvitation = async (actorId: string, rawWorkspaceId: unknown, invitationId: unknown) => {
  const workspaceId = await assertCanProvisionMembers(actorId, rawWorkspaceId);
  const invitation = await loadScopedInvitation(workspaceId, invitationId);
  const { userId, email, issued } = await reissueAccountInvitation(actorId, invitation.userId, { tier: 'MEMBER', workspaceId });
  const fresh = await prisma.accountInvitation.findFirstOrThrow({ where: { userId, status: 'PENDING' }, select: { id: true } });
  return { invitation: await loadMemberInvitation(fresh.id), credentials: credentialsResponse(email, issued) };
};

/** GET /api/me/hierarchy — UI hints only (every action is re-checked on the server). */
export const myHierarchy = async (userId: string) => {
  const hierarchy = await loadHierarchyActor(userId);
  return {
    role: hierarchy.role,
    canCreateWorkspaces: canCreateWorkspaces(hierarchy),
    canProvisionMembers: hierarchy.active && hierarchy.role === 'TEAM_LEAD',
  };
};
