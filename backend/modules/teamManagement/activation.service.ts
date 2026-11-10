import bcrypt from 'bcryptjs';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { canWorkspace, loadWorkspaceActor } from '../../lib/policy';
import { ensureSharedWorkspaceMembership } from '../../lib/sharedWorkspace';
import { ensureOrganizationMembership } from '../organizations/organizations.service';
import {
  ACTIVATION_TOKEN_PATTERN,
  BCRYPT_COST,
  credentialFingerprint,
  hashActivationToken,
  MAX_ACTIVATION_ATTEMPTS,
  NEW_PASSWORD_MAX,
  NEW_PASSWORD_MIN,
} from './credentials';

/**
 * Stage 2 (T.20) — POST /api/account-activation { token, temporaryPassword, newPassword }
 *
 * A one-time step that turns a provisioned account into a usable one. It is
 * NOT a login: it verifies the link token (by hash), the invitation's state,
 * the temporary password (bcrypt, attempt-limited) and the account, then — in
 * one transaction — consumes the invitation (PENDING → ACCEPTED, the single-
 * use lock), replaces the account's unknowable password with the new one and
 * moves the account from SUSPENDED (awaiting activation) to ACTIVE (T.21).
 * No session token is issued; the person then signs in through the existing,
 * unchanged login. The frozen login, JWT and session code are not involved.
 *
 * Bad credentials answer 400 (not 401): the web client signs out on any 401,
 * and activation must never sign out whoever is using that browser.
 */

// Same answer for an unknown token and a wrong temporary password — it never
// reveals which part was wrong, or anything about any e-mail address.
const NOT_VALID = 'This activation link or temporary password is not valid.';
const USED = 'This invitation has already been used. Sign in with your password.';
const NOT_ACTIVATABLE = 'This account cannot be activated. Contact your administrator.';

const recordFailedAttempt = async (invitationId: string) => {
  const { failedAttempts } = await prisma.accountInvitation.update({
    where: { id: invitationId },
    data: { failedAttempts: { increment: 1 } },
    select: { failedAttempts: true },
  });
  if (failedAttempts >= MAX_ACTIVATION_ATTEMPTS) {
    await prisma.accountInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'TOO_MANY_ATTEMPTS', tempPasswordHash: null },
    });
  }
};

/**
 * Stage 3 (T.22): a Member provisioned by a Team Lead joins that lead's
 * workspace (as MEMBER, plus its General channel) once the account is
 * ACTIVE — and only if the inviter may still invite to that workspace (the
 * same rule e-mail invitations follow). Otherwise the account keeps
 * SmartConnect Collab only. Never grants anything above MEMBER.
 */
const joinAssignedWorkspace = async (userId: string, workspaceId: string, inviterId: string) => {
  let allowed = false;
  try {
    allowed = canWorkspace(await loadWorkspaceActor(inviterId, workspaceId), 'workspace.manageInvitations');
  } catch {
    allowed = false; // workspace gone
  }
  if (!allowed) return;
  const general = await prisma.channel.findFirst({
    where: { workspaceId, isDM: false, archivedAt: null, name: { equals: 'General', mode: 'insensitive' } },
    select: { id: true },
  });
  await prisma.$transaction([
    prisma.workspaceMember.createMany({ data: [{ userId, workspaceId, role: 'MEMBER' }], skipDuplicates: true }),
    ...(general ? [prisma.channelMember.createMany({ data: [{ userId, channelId: general.id, role: 'member' }], skipDuplicates: true })] : []),
  ]);
  await ensureOrganizationMembership(workspaceId, userId);
};

export const activateAccount = async (body: Record<string, unknown> | undefined) => {
  const token = body?.token;
  const temporaryPassword = body?.temporaryPassword;
  const newPassword = body?.newPassword;
  if (typeof token !== 'string' || !ACTIVATION_TOKEN_PATTERN.test(token)) throw new HttpError(400, NOT_VALID);
  if (typeof temporaryPassword !== 'string' || temporaryPassword.length === 0 || temporaryPassword.length > NEW_PASSWORD_MAX) {
    throw new HttpError(400, NOT_VALID);
  }
  if (typeof newPassword !== 'string' || newPassword.length < NEW_PASSWORD_MIN || newPassword.length > NEW_PASSWORD_MAX) {
    throw new HttpError(400, `Choose a new password of ${NEW_PASSWORD_MIN}–${NEW_PASSWORD_MAX} characters.`);
  }

  const invitation = await prisma.accountInvitation.findUnique({
    where: { tokenHash: hashActivationToken(token) },
    select: {
      id: true,
      userId: true,
      status: true,
      expiresAt: true,
      tempPasswordHash: true,
      credentialFingerprint: true,
      intendedTier: true,
      workspaceId: true,
      createdById: true,
      user: { select: { email: true, status: true } },
    },
  });
  if (!invitation) throw new HttpError(400, NOT_VALID);
  if (invitation.status === 'ACCEPTED') throw new HttpError(410, USED);
  if (invitation.status === 'REVOKED') throw new HttpError(410, 'This invitation has been revoked. Ask your administrator for a new one.');
  if (invitation.expiresAt.getTime() <= Date.now()) throw new HttpError(410, 'This invitation has expired. Ask your administrator for a new one.');

  if (!invitation.tempPasswordHash || !(await bcrypt.compare(temporaryPassword, invitation.tempPasswordHash))) {
    await recordFailedAttempt(invitation.id);
    throw new HttpError(400, NOT_VALID);
  }

  const loginId = invitation.user.email;
  if (newPassword === temporaryPassword) throw new HttpError(400, 'Choose a new password that is different from the temporary one.');
  if (newPassword.toLowerCase() === loginId.toLowerCase()) throw new HttpError(400, 'Your password cannot be your e-mail address.');
  // Only an account still awaiting activation: not banned, and not reinstated
  // some other way (the existing admin status control).
  if (invitation.user.status !== 'SUSPENDED') throw new HttpError(403, NOT_ACTIVATABLE);

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const consumed = await prisma.$transaction(async (tx) => {
    // The single-use lock: only one request can flip PENDING → ACCEPTED; a
    // concurrent one waits on the row, then matches nothing.
    const now = new Date();
    const flipped = await tx.accountInvitation.updateMany({
      where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'ACCEPTED', acceptedAt: now, tempPasswordHash: null },
    });
    if (flipped.count === 0) return false;
    const account = await tx.user.findUniqueOrThrow({
      where: { id: invitation.userId },
      select: { status: true, password: true, accountTier: { select: { tier: true } } },
    });
    if (account.status !== 'SUSPENDED') throw new HttpError(403, NOT_ACTIVATABLE);
    // The account must still hold the role the invitation was issued for.
    // No grant row = MEMBER (Stage 1); a Member invitation needs exactly that.
    if ((account.accountTier?.tier ?? 'MEMBER') !== invitation.intendedTier) {
      throw new HttpError(409, 'This invitation no longer matches the account. Ask your administrator for a new one.');
    }
    // Never overwrite a password that was set some other way since the
    // invitation was issued (e.g. an admin's "Set password"); the throw rolls
    // the whole transaction back, so the invitation stays pending.
    if (credentialFingerprint(account.password) !== invitation.credentialFingerprint) {
      throw new HttpError(409, "This account's password has already been set another way. Sign in with it, or ask your administrator.");
    }
    // Password and status change together, with the invitation consumed above.
    await tx.user.update({ where: { id: invitation.userId }, data: { password: passwordHash, status: 'ACTIVE' } });
    return true;
  });
  if (!consumed) throw new HttpError(410, USED);

  await ensureSharedWorkspaceMembership(invitation.userId); // SmartConnect Collab, as for every active account
  if (invitation.workspaceId && invitation.createdById) await joinAssignedWorkspace(invitation.userId, invitation.workspaceId, invitation.createdById);
  await logAuditEvent(invitation.userId, 'ACTIVATE_ACCOUNT', 'USER', invitation.userId, 'Activated the account with a one-time invitation');
  return { activated: true as const, loginId };
};
