import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { APP_URL, JWT_SECRET } from '../../config/env';
import { isValidEmail } from '../../lib/email';
import { prisma } from '../../lib/prisma';
import { sendInviteEmail } from '../../utils/mailer';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { findUserIdByEmail } from '../../lib/identity';
import { isUuid } from '../../lib/messageInput';
import {
  assertWorkspace,
  canJoinWorkspaces,
  canWorkspace,
  InvitationDenial,
  invitationAcceptanceDenial,
  invitationExpiresAt,
  invitationState,
  loadWorkspaceActor,
  normalizeEmail,
} from '../../lib/policy';

/**
 * Batch 3/E: every management decision here is lib/policy
 * 'workspace.manageInvitations' (workspace owner/ADMINs plus organization
 * OWNER/ADMINs) — the old inline "WorkspaceMember.role === 'ADMIN'" check
 * ignored organization inheritance. 404 for a missing workspace, 403 for a
 * caller without the right (the established workspace convention).
 */
const assertCanManageInvitations = async (userId: string, workspaceId: unknown) => {
  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new HttpError(400, 'workspaceId is required');
  }
  const actor = await loadWorkspaceActor(userId, workspaceId);
  assertWorkspace(actor, 'workspace.manageInvitations');
  return actor;
};

/** Is `userId` (still) allowed to manage invitations for `workspaceId`? */
const stillManages = async (userId: string, workspaceId: string) =>
  canWorkspace(await loadWorkspaceActor(userId, workspaceId), 'workspace.manageInvitations');

// Stage 6C (IDN-3): exact and case-insensitive; "_", "%" and "\" are ordinary characters.
const findUserByEmail = async (email: string) => {
  const id = await findUserIdByEmail(prisma, email);
  return id ? { id } : null;
};

/**
 * GET /api/invitations[?workspaceId=] — invitations the caller sent, limited
 * to workspaces they can STILL manage (a removed or demoted admin no longer
 * sees, or can copy, those invite tokens).
 */
export const listInvitations = async (inviterId: string, workspaceId?: unknown) => {
  const rows = await prisma.invitation.findMany({
    where: { inviterId, ...(typeof workspaceId === 'string' && workspaceId ? { workspaceId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  const workspaceIds = [...new Set(rows.map((r) => r.workspaceId))];
  const allowed = new Set<string>();
  for (const id of workspaceIds) if (await stillManages(inviterId, id)) allowed.add(id);
  return rows
    .filter((r) => allowed.has(r.workspaceId))
    .map((r) => ({ ...r, state: invitationState(r), expiresAt: invitationExpiresAt(r) }));
};

/** GET /api/workspaces/:workspaceId/invitations — managers; never exposes tokens. */
export const listWorkspaceInvitations = async (actorId: string, workspaceId: string) => {
  await assertCanManageInvitations(actorId, workspaceId);
  const rows = await prisma.invitation.findMany({
    where: { workspaceId },
    select: { id: true, email: true, status: true, createdAt: true, inviter: { select: { id: true, username: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map(({ status, ...row }) => ({ ...row, state: invitationState({ status, createdAt: row.createdAt }), expiresAt: invitationExpiresAt(row) }));
};

export const createInvitation = async (email: unknown, inviterId: string, workspaceId: unknown) => {
  if (!email || typeof email !== 'string') {
    throw new HttpError(400, 'Valid email required');
  }
  const normalized = normalizeEmail(email);
  // FA-SEC-02: the 254-character cap now runs before the pattern (it ran after).
  if (!isValidEmail(normalized)) {
    throw new HttpError(400, 'Invalid email format');
  }
  await assertCanManageInvitations(inviterId, workspaceId);
  const workspaceKey = workspaceId as string;
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceKey }, select: { name: true } });

  // Inviting someone who already has an account is the whole point now (see
  // acceptInvitation/isExistingUser) — what actually needs blocking is
  // inviting someone who's already IN this specific workspace, which would
  // just be a confusing no-op invite.
  const existingUser = await findUserByEmail(normalized);
  if (existingUser) {
    const alreadyMember = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: existingUser.id, workspaceId: workspaceKey } },
    });
    if (alreadyMember) {
      throw new HttpError(400, 'This user is already a member of this workspace.');
    }
  }

  const invitation = await prisma.invitation.create({ data: { email: normalized, inviterId, workspaceId: workspaceKey } });
  await logAuditEvent(inviterId, 'CREATE_INVITATION', 'WORKSPACE', workspaceKey, `Invited ${normalized}`);
  const inviteLink = `${APP_URL}/invite/${invitation.token}`;

  try {
    await sendInviteEmail(normalized, inviteLink, workspace.name);
  } catch (emailErr: any) {
    console.error('Email sending failed:', emailErr.message);
    return {
      status: 201,
      body: {
        success: true,
        message: 'Invitation created but email failed to send',
        token: invitation.token,
        id: invitation.id,
        emailError: emailErr.message,
      },
    };
  }

  return {
    status: 201,
    body: { success: true, message: 'Invite sent successfully', token: invitation.token, id: invitation.id },
  };
};

/** DELETE /api/workspaces/:workspaceId/invitations/:invitationId — managers revoke a pending invitation. */
export const revokeInvitation = async (actorId: string, workspaceId: string, invitationId: unknown) => {
  await assertCanManageInvitations(actorId, workspaceId);
  const invitation = isUuid(invitationId)
    ? await prisma.invitation.findFirst({ where: { id: invitationId, workspaceId } })
    : null;
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  const revoked = await prisma.invitation.updateMany({
    where: { id: invitation.id, status: 'pending' },
    data: { status: 'revoked' },
  });
  if (revoked.count === 0) throw new HttpError(400, 'Only pending invitations can be revoked.');
  await logAuditEvent(actorId, 'REVOKE_INVITATION', 'WORKSPACE', workspaceId, `Revoked the invitation for ${invitation.email}`);
  return { id: invitation.id, state: 'revoked' as const };
};

const DENIALS: Record<InvitationDenial, [number, (email: string) => string]> = {
  used: [400, () => 'This invitation has already been used.'],
  revoked: [400, () => 'This invitation has been revoked.'],
  expired: [400, () => 'This invitation has expired.'],
  inviterLostAccess: [400, () => 'This invitation is no longer valid.'],
  wrongAccount: [403, (email) => `This invitation was sent to ${email}, not the account you're signed in as.`],
  inactiveAccount: [403, () => 'This account is not active.'],
};

/**
 * Public token inspection — no auth required, since InviteHandler.tsx calls
 * this before it knows whether the visitor is logged in at all. The
 * `isExistingUser` flag is what lets the frontend decide whether to route the
 * visitor to /login (existing account) or /signup (brand-new invitee)
 * without ever needing to attempt a login itself just to find out.
 */
export const getInvitationByToken = async (token: string) => {
  if (!token) throw new HttpError(400, 'Invalid invitation token');

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { workspace: { select: { id: true, name: true } } },
  });
  if (!invitation) throw new HttpError(404, 'Invitation not found or expired');
  const state = invitationState(invitation);
  const denial: InvitationDenial | null =
    state === 'accepted' ? 'used' : state === 'revoked' ? 'revoked' : state === 'expired' ? 'expired'
      : (await stillManages(invitation.inviterId, invitation.workspaceId)) ? null : 'inviterLostAccess';
  if (denial) throw new HttpError(DENIALS[denial][0], DENIALS[denial][1](invitation.email));

  const existingUser = await findUserByEmail(invitation.email);

  return {
    valid: true as const,
    email: invitation.email,
    workspaceId: invitation.workspace.id,
    workspaceName: invitation.workspace.name,
    isExistingUser: !!existingUser,
  };
};

/**
 * Consumes an invitation for the CALLER'S OWN, already-authenticated session
 * — this never creates an account itself. Batch 3/E rules (lib/policy
 * invitationAcceptanceDenial): pending and not expired, the inviter must
 * still be allowed to invite, the session's email must match the invited
 * address (case-insensitively), and the account must be active. Grants plain
 * MEMBER only. Single-use is atomic; a duplicate accept by the same person
 * (double click, StrictMode) is a harmless success.
 */
export const acceptInvitation = async (token: string, userId: string) => {
  if (!token) throw new HttpError(400, 'Invalid invitation token');

  const invitation = await prisma.invitation.findUnique({ where: { token } });
  if (!invitation) throw new HttpError(404, 'Invitation not found or expired');

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true } });
  if (!user) throw new HttpError(404, 'User not found');

  const generalChannel = await prisma.channel.findFirst({
    where: { name: 'General', isDM: false, workspaceId: invitation.workspaceId },
  });
  const alreadyJoined = async () =>
    !!(await prisma.workspaceMember.findUnique({ where: { userId_workspaceId: { userId, workspaceId: invitation.workspaceId } } }));

  const denial = invitationAcceptanceDenial({
    state: invitationState(invitation),
    inviteeEmail: invitation.email,
    accountEmail: user.email,
    accountActive: canJoinWorkspaces(user),
    inviterCanManage: await stillManages(invitation.inviterId, invitation.workspaceId),
  });
  if (denial === 'used' && normalizeEmail(invitation.email) === normalizeEmail(user.email) && (await alreadyJoined()) && generalChannel) {
    return { workspaceId: invitation.workspaceId, generalChannelId: generalChannel.id };
  }
  if (denial) throw new HttpError(DENIALS[denial][0], DENIALS[denial][1](invitation.email));
  if (!generalChannel) {
    throw new HttpError(500, 'This workspace has no "General" channel to join — contact an admin.');
  }

  const consumed = await prisma.$transaction(async (tx) => {
    // Conditional update = the single-use lock: only one accept can flip it.
    const flipped = await tx.invitation.updateMany({ where: { id: invitation.id, status: 'pending' }, data: { status: 'accepted' } });
    if (flipped.count === 0) return false;
    await tx.workspaceMember.upsert({
      where: { userId_workspaceId: { userId, workspaceId: invitation.workspaceId } },
      update: {},
      create: { userId, workspaceId: invitation.workspaceId, role: 'MEMBER' },
    });
    await tx.channelMember.upsert({
      where: { userId_channelId: { userId, channelId: generalChannel.id } },
      update: {},
      create: { userId, channelId: generalChannel.id, role: 'member' },
    });
    return true;
  });
  // Lost the race to a concurrent accept: fine if it was this same person.
  if (!consumed && !(await alreadyJoined())) throw new HttpError(400, DENIALS.used[1](invitation.email));

  return { workspaceId: invitation.workspaceId, generalChannelId: generalChannel.id };
};

// Discord/Slack-style reusable invite link — "anyone with the link can ask
// to join". Backed by an opaque random token in WorkspaceInviteLink.
//
// These used to be JWTs signed with the session JWT_SECRET and carrying only
// { workspaceId }. Because `authenticate` accepts any JWT signed with that
// secret, a link token doubled as a login token with no user id, which
// unscoped several list queries (audit SEC-01). DB tokens can't be confused
// with session JWTs and can be expired/revoked per link.
const INVITE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Reuse the newest active link unless it expires within a day, so repeatedly
// opening the invite dialog doesn't mint a new row every time.
const INVITE_LINK_MIN_REMAINING_MS = 24 * 60 * 60 * 1000;

const newInviteToken = () => crypto.randomBytes(32).toString('base64url');

export const getWorkspaceInviteLink = async (adminId: string, workspaceId: string) => {
  await assertCanManageInvitations(adminId, workspaceId);

  const reusable = await prisma.workspaceInviteLink.findFirst({
    where: {
      workspaceId,
      revokedAt: null,
      expiresAt: { gt: new Date(Date.now() + INVITE_LINK_MIN_REMAINING_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  const link =
    reusable ??
    (await prisma.workspaceInviteLink.create({
      data: {
        token: newInviteToken(),
        workspaceId,
        createdById: adminId,
        expiresAt: new Date(Date.now() + INVITE_LINK_TTL_MS),
      },
    }));

  return { url: `${APP_URL}/join-workspace?token=${link.token}`, expiresAt: link.expiresAt };
};

/** DELETE /api/workspaces/:workspaceId/invite-link — revokes every active link (new ones can be generated). */
export const revokeInviteLinks = async (actorId: string, workspaceId: string) => {
  await assertCanManageInvitations(actorId, workspaceId);
  const result = await prisma.workspaceInviteLink.updateMany({
    where: { workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await logAuditEvent(actorId, 'REVOKE_INVITE_LINKS', 'WORKSPACE', workspaceId, `Revoked ${result.count} invite link(s)`);
  return { revoked: result.count };
};

interface LegacyWorkspaceJoinTokenPayload {
  workspaceId?: unknown;
}

/**
 * Resolves a join-link token to its workspace id.
 *
 * LEGACY: JWT links issued before this change are still honoured, verify
 * only, until they expire naturally (7-day TTL). No code path mints them
 * anymore, so this branch can be deleted once this change has been deployed
 * for 7 days.
 */
const resolveInviteToken = async (token: string): Promise<{ workspaceId: string; linkId: string | null }> => {
  const link = await prisma.workspaceInviteLink.findUnique({ where: { token } });
  if (link) {
    if (link.revokedAt || link.expiresAt.getTime() <= Date.now()) {
      throw new HttpError(400, 'This invite link is invalid or has expired.');
    }
    return { workspaceId: link.workspaceId, linkId: link.id };
  }

  if (token.split('.').length === 3) {
    try {
      const payload = jwt.verify(token, JWT_SECRET as string) as LegacyWorkspaceJoinTokenPayload;
      if (typeof payload.workspaceId === 'string' && payload.workspaceId) {
        return { workspaceId: payload.workspaceId, linkId: null };
      }
    } catch {
      // fall through to the generic error below
    }
  }
  throw new HttpError(400, 'This invite link is invalid or has expired.');
};

// Authenticated — files a join request for whoever is currently signed in.
// No email-match check (unlike acceptInvitation): this link was never bound
// to a specific recipient in the first place. Deliberately does NOT add the
// user to WorkspaceMember directly — see resolveJoinRequest, which is the
// only place that actually happens, gated on admin approval.
export const requestToJoinWorkspace = async (userId: string, token: string) => {
  if (!token || typeof token !== 'string' || token.length > 2048) {
    throw new HttpError(400, 'Invalid invite link');
  }

  const { workspaceId, linkId } = await resolveInviteToken(token);

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) {
    throw new HttpError(404, 'This workspace no longer exists.');
  }
  // Batch 3/E: suspended/banned accounts can't ask to join anything.
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!account || !canJoinWorkspaces(account)) throw new HttpError(403, 'This account is not active.');

  // Already a member (e.g. re-clicking an old link, or a previously
  // approved request) — no need to file another request, just let them
  // straight in like a normal workspace open.
  const existingMembership = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (existingMembership) {
    const generalChannel = await prisma.channel.findFirst({
      where: { name: 'General', isDM: false, workspaceId },
    });
    if (!generalChannel) {
      throw new HttpError(500, 'This workspace has no "General" channel to join — contact an admin.');
    }
    return { status: 'already_member' as const, workspaceId, generalChannelId: generalChannel.id };
  }

  // Upsert rather than a plain create: re-requesting after a REJECTED
  // decision resets the same row back to PENDING instead of failing on the
  // @@unique([userId, workspaceId]) constraint or piling up duplicate rows.
  // Re-requesting while already PENDING is a harmless no-op (same result).
  await prisma.workspaceJoinRequest.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: { status: 'PENDING' },
    create: { userId, workspaceId, status: 'PENDING' },
  });
  if (linkId) {
    await prisma.workspaceInviteLink.update({ where: { id: linkId }, data: { useCount: { increment: 1 } } });
  }

  return { status: 'pending' as const };
};

// GET /api/workspaces/:workspaceId/requests — admin only.
export const listPendingJoinRequests = async (adminId: string, workspaceId: string) => {
  await assertCanManageInvitations(adminId, workspaceId);

  return prisma.workspaceJoinRequest.findMany({
    where: { workspaceId, status: 'PENDING' },
    include: { user: { select: { id: true, username: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });
};

// PUT /api/workspaces/:workspaceId/requests/:requestId — admin only.
// APPROVE is the only path that actually creates the WorkspaceMember (+
// General ChannelMember) row — the reusable link itself no longer does this
// directly (see requestToJoinWorkspace above).
export const resolveJoinRequest = async (
  adminId: string,
  workspaceId: string,
  requestId: string,
  action: 'APPROVE' | 'REJECT'
) => {
  await assertCanManageInvitations(adminId, workspaceId);

  if (action !== 'APPROVE' && action !== 'REJECT') {
    throw new HttpError(400, 'action must be APPROVE or REJECT');
  }

  const joinRequest = isUuid(requestId) ? await prisma.workspaceJoinRequest.findUnique({ where: { id: requestId } }) : null;
  if (!joinRequest || joinRequest.workspaceId !== workspaceId) {
    throw new HttpError(404, 'Join request not found');
  }
  if (joinRequest.status !== 'PENDING') {
    throw new HttpError(400, 'This request has already been resolved.');
  }

  if (action === 'REJECT') {
    // Conditional update: a concurrent APPROVE/REJECT can't both win.
    const rejected = await prisma.workspaceJoinRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: { status: 'REJECTED' },
    });
    if (rejected.count === 0) throw new HttpError(400, 'This request has already been resolved.');
    await logAuditEvent(adminId, 'REJECT_JOIN_REQUEST', 'WORKSPACE', workspaceId, `Rejected join request of user ${joinRequest.userId}`);
    return { status: 'REJECTED' as const };
  }

  // Batch 3/E: never approve a suspended/banned account into a workspace.
  const requester = await prisma.user.findUnique({ where: { id: joinRequest.userId }, select: { status: true } });
  if (!requester || !canJoinWorkspaces(requester)) {
    throw new HttpError(409, 'That account is not active and cannot join this workspace.');
  }

  const generalChannel = await prisma.channel.findFirst({
    where: { name: 'General', isDM: false, workspaceId },
  });
  if (!generalChannel) {
    throw new HttpError(500, 'This workspace has no "General" channel to add the user to — contact an admin.');
  }

  await prisma.$transaction(async (tx) => {
    const approved = await tx.workspaceJoinRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: { status: 'APPROVED' },
    });
    if (approved.count === 0) throw new HttpError(400, 'This request has already been resolved.');
    // Always plain MEMBER — the requester never chooses a role.
    await tx.workspaceMember.upsert({
      where: { userId_workspaceId: { userId: joinRequest.userId, workspaceId } },
      update: {},
      create: { userId: joinRequest.userId, workspaceId, role: 'MEMBER' },
    });
    await tx.channelMember.upsert({
      where: { userId_channelId: { userId: joinRequest.userId, channelId: generalChannel.id } },
      update: {},
      create: { userId: joinRequest.userId, channelId: generalChannel.id, role: 'member' },
    });
  });
  await logAuditEvent(adminId, 'APPROVE_JOIN_REQUEST', 'WORKSPACE', workspaceId, `Approved join request of user ${joinRequest.userId}`);

  return {
    status: 'APPROVED' as const,
    approvedUserId: joinRequest.userId,
    generalChannelId: generalChannel.id,
  };
};

export { HttpError };
