import bcrypt from 'bcryptjs';
import { AccountInvitationStatus, AccountTier, Prisma } from '@prisma/client';
import { APP_URL } from '../../config/env';
import { logAuditEvent } from '../../lib/auditLog';
import { isValidEmail } from '../../lib/email';
import { HttpError } from '../../lib/httpError';
import { findUserIdByEmail, findUserIdByUsername } from '../../lib/identity';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import { SYSTEM_USER_EMAIL } from '../../lib/sharedWorkspace';
import {
  BCRYPT_COST,
  credentialFingerprint,
  generateActivationToken,
  generateTemporaryPassword,
  generateUnusablePassword,
  hashActivationToken,
  invitationTtlMs,
} from './credentials';

/**
 * Stage 2 (T.20) — Company Admin → Team Lead provisioning. Every route that
 * calls these is mounted behind requireSessionUser + requireAdmin (unchanged,
 * DB role re-check), so only Company Admins (platform ADMIN) reach them.
 *
 * Separate from the existing admin "Create user" (userProvisioning.service,
 * unchanged): this creates an ordinary USER account holding the TEAM_LEAD
 * tier, with an unknowable password, plus a single-use activation invitation.
 * The account stays SUSPENDED until activation (T.21): no sign-in by any
 * route (login, forgot-password reset, sockets), and no SmartConnect Collab
 * membership (the reconcile only adds ACTIVE accounts) until then.
 * The plaintext link token and temporary password are returned ONCE, in the
 * response to the admin who created them, and are never stored or logged.
 */

export const RESERVED_EMAILS = [SYSTEM_USER_EMAIL, 'deleted-user@system.internal'];
const TEXT_MAX = 80;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const DUPLICATE = 'An account with this e-mail address already exists.';

export type InvitationView = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';

/** EXPIRED is derived: a PENDING invitation whose expiry has passed. */
export const invitationView = (invitation: { status: AccountInvitationStatus; expiresAt: Date }, now = Date.now()): InvitationView =>
  invitation.status === 'PENDING' && invitation.expiresAt.getTime() <= now ? 'EXPIRED' : invitation.status;

// Explicit selections: hashes and fingerprints are never read into a response.
export const INVITATION_SELECT = {
  id: true,
  status: true,
  teamLabel: true,
  expiresAt: true,
  createdAt: true,
  acceptedAt: true,
  revokedAt: true,
  revokedReason: true,
} as const;

const TEAM_LEAD_SELECT = {
  id: true,
  username: true,
  email: true,
  status: true,
  createdAt: true,
  profile: { select: { displayName: true } },
  accountInvitations: { orderBy: { createdAt: 'desc' as const }, take: 1, select: INVITATION_SELECT },
} as const;

type InvitationRow = Prisma.AccountInvitationGetPayload<{ select: typeof INVITATION_SELECT }>;
type TeamLeadRow = Prisma.UserGetPayload<{ select: typeof TEAM_LEAD_SELECT }>;

export const toInvitation = (invitation: InvitationRow) => ({ ...invitation, status: invitationView(invitation) });

const toTeamLead = (user: TeamLeadRow) => ({
  id: user.id,
  username: user.username,
  loginId: user.email,
  displayName: user.profile?.displayName ?? null,
  status: user.status,
  createdAt: user.createdAt,
  invitation: user.accountInvitations[0] ? toInvitation(user.accountInvitations[0]) : null,
});

const loadTeamLead = async (userId: string) =>
  toTeamLead(await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: TEAM_LEAD_SELECT }));

// The token travels in the URL fragment, which browsers never send to a
// server — so it cannot end up in access logs or Referer headers.
export const activationUrl = (token: string) => `${APP_URL.replace(/\/+$/, '')}/activate#token=${token}`;

export const parseEmail = (value: unknown) => {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a valid e-mail address.');
  const email = value.trim().toLowerCase();
  // isValidEmail caps the length before its pattern runs (FA-SEC-02).
  if (!isValidEmail(email)) throw new HttpError(400, 'Enter a valid e-mail address.');
  return email;
};

export const parseOptionalText = (value: unknown, label: string) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > TEXT_MAX || CONTROL_CHARS.test(text)) throw new HttpError(400, `${label} must be at most ${TEXT_MAX} characters.`);
  return text;
};

/** A readable, unique username (3–40 characters: letters, digits, ".", "_", "-"). */
export const uniqueUsername = async (displayName: string | null, email: string) => {
  const source = (displayName ?? email.split('@')[0]).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let base = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/[._-]{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 30)
    .replace(/[._-]+$/g, '');
  if (base.length < 3) base = 'teamlead';
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base}${n}`;
    // Stage 6C (IDN-3): exact and case-insensitive; "_" is not a wildcard.
    if (!(await findUserIdByUsername(prisma, candidate))) return candidate;
  }
  return `${base}.${generateActivationToken().replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
};

export const uniqueViolationOn = (err: unknown, field: string) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && JSON.stringify(err.meta?.target ?? '').includes(field);

/** Fresh one-time credentials and the invitation row data that stores only their hashes. */
export const issueCredentials = async () => {
  const token = generateActivationToken();
  const temporaryPassword = generateTemporaryPassword();
  const tempPasswordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);
  const expiresAt = new Date(Date.now() + invitationTtlMs());
  return { token, temporaryPassword, expiresAt, row: { tokenHash: hashActivationToken(token), tempPasswordHash, expiresAt } };
};

export const credentialsResponse = (loginId: string, issued: Awaited<ReturnType<typeof issueCredentials>>) => ({
  loginId,
  temporaryPassword: issued.temporaryPassword,
  activationUrl: activationUrl(issued.token),
  expiresAt: issued.expiresAt,
});

/** POST /api/team-management/team-leads { email, displayName?, teamLabel? } */
export const provisionTeamLead = async (adminId: string, body: Record<string, unknown> | undefined) => {
  // Only these three fields are read; anything else in the body (role, tier,
  // status, password, …) is ignored.
  const email = parseEmail(body?.email);
  const displayName = parseOptionalText(body?.displayName, 'Display name');
  const teamLabel = parseOptionalText(body?.teamLabel, 'Team label');

  if (RESERVED_EMAILS.includes(email)) throw new HttpError(409, DUPLICATE);
  // Stage 6C (IDN-3): exact and case-insensitive; "_", "%" and "\" are ordinary characters.
  if (await findUserIdByEmail(prisma, email)) throw new HttpError(409, DUPLICATE);

  const { userId, username, issued } = await createInvitedAccount(adminId, { email, displayName, teamLabel, tier: 'TEAM_LEAD', workspaceId: null });
  await logAuditEvent(
    adminId,
    'PROVISION_TEAM_LEAD',
    'USER',
    userId,
    `Provisioned Team Lead "${username}" (login ${email})${teamLabel ? ` for "${teamLabel}"` : ''}; invitation expires ${issued.expiresAt.toISOString()}`
  );
  return { teamLead: await loadTeamLead(userId), credentials: credentialsResponse(email, issued) };
};

/**
 * Shared by Company Admin → Team Lead (Stage 2) and Team Lead → Member
 * (Stage 3): one SUSPENDED account with an unknowable password, its tier
 * (a TEAM_LEAD grant; Members get no row = MEMBER), and one PENDING
 * activation invitation storing only hashes. Callers authorize and check
 * duplicates first; a concurrent duplicate e-mail still ends in 409 here.
 */
export const createInvitedAccount = async (
  creatorId: string,
  account: { email: string; displayName: string | null; teamLabel: string | null; tier: AccountTier; workspaceId: string | null }
) => {
  const { email, displayName, teamLabel, tier, workspaceId } = account;
  // The account's own password is an unknowable random value: the normal
  // login can never accept the temporary password, which lives only (hashed)
  // on the invitation.
  const placeholderHash = await bcrypt.hash(generateUnusablePassword(), BCRYPT_COST);
  const issued = await issueCredentials();
  for (let attempt = 0; attempt < 3; attempt++) {
    const username = await uniqueUsername(displayName, email);
    try {
      const userId = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            username,
            email,
            password: placeholderHash,
            role: 'USER', // never platform ADMIN
            status: 'SUSPENDED', // until activation (T.21)
            ...(displayName ? { profile: { create: { displayName } } } : {}),
          },
          select: { id: true },
        });
        if (tier === 'TEAM_LEAD') await tx.accountTierGrant.create({ data: { userId: user.id, tier: 'TEAM_LEAD', grantedById: creatorId } });
        await tx.accountInvitation.create({
          data: {
            ...issued.row,
            userId: user.id,
            intendedTier: tier,
            credentialFingerprint: credentialFingerprint(placeholderHash),
            teamLabel,
            workspaceId,
            createdById: creatorId,
          },
        });
        return user.id;
      });
      return { userId, username, issued };
    } catch (err) {
      if (uniqueViolationOn(err, 'email')) throw new HttpError(409, DUPLICATE);
      if (uniqueViolationOn(err, 'username')) continue; // lost a race for the generated username — pick another
      throw err;
    }
  }
  throw new HttpError(409, 'Could not allocate a unique username. Please try again.');
};

/** GET /api/team-management/team-leads — every Team Lead with their latest invitation (no secrets). */
export const listTeamLeads = async () => {
  const users = await prisma.user.findMany({
    where: { accountTier: { tier: 'TEAM_LEAD' } },
    select: TEAM_LEAD_SELECT,
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return users.map(toTeamLead);
};

/** POST /api/team-management/invitations/:invitationId/revoke — pending (or expired) only. */
export const revokeInvitation = async (adminId: string, invitationId: unknown) => {
  if (!isUuid(invitationId)) throw new HttpError(404, 'Invitation not found.');
  const invitation = await prisma.accountInvitation.findUnique({
    where: { id: invitationId },
    select: { id: true, userId: true, user: { select: { username: true } } },
  });
  if (!invitation) throw new HttpError(404, 'Invitation not found.');
  const revoked = await prisma.accountInvitation.updateMany({
    where: { id: invitationId, status: 'PENDING' },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'ADMIN', tempPasswordHash: null },
  });
  if (revoked.count === 0) throw new HttpError(409, 'Only pending invitations can be revoked.');
  await logAuditEvent(adminId, 'REVOKE_ACCOUNT_INVITATION', 'USER', invitation.userId, `Revoked the activation invitation of "${invitation.user.username}"`);
  return { invitation: toInvitation(await prisma.accountInvitation.findUniqueOrThrow({ where: { id: invitationId }, select: INVITATION_SELECT })) };
};

/**
 * POST /api/team-management/team-leads/:userId/reissue — a fresh invitation
 * for a provisioned Team Lead who never activated (previous one expired or
 * revoked). Refused while a live invitation exists, after activation, or if
 * the account's password was set some other way.
 */
export const reissueInvitation = async (adminId: string, userId: unknown) => {
  const { email, issued, userId: id } = await reissueAccountInvitation(adminId, userId, { tier: 'TEAM_LEAD', workspaceId: null });
  return { teamLead: await loadTeamLead(id), credentials: credentialsResponse(email, issued) };
};

/**
 * Shared reissue (Stage 2 Team Leads, Stage 3 Members): a fresh invitation for
 * a provisioned account that never activated, within the caller's scope (the
 * account's tier, and — for Members — the workspace the invitation binds).
 */
export const reissueAccountInvitation = async (
  actorId: string,
  userId: unknown,
  scope: { tier: AccountTier; workspaceId: string | null }
) => {
  const NOT_FOUND = 'No pending activation to reissue for this account.';
  if (!isUuid(userId)) throw new HttpError(404, NOT_FOUND);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      email: true,
      status: true,
      password: true, // used only to compare fingerprints below; never returned
      accountTier: { select: { tier: true } },
      accountInvitations: {
        orderBy: { createdAt: 'desc' },
        select: { status: true, expiresAt: true, credentialFingerprint: true, teamLabel: true, intendedTier: true, workspaceId: true },
      },
    },
  });
  const latest = user?.accountInvitations[0];
  if (
    !user ||
    !latest ||
    (user.accountTier?.tier ?? 'MEMBER') !== scope.tier ||
    latest.intendedTier !== scope.tier ||
    (latest.workspaceId ?? null) !== scope.workspaceId
  ) {
    throw new HttpError(404, NOT_FOUND);
  }
  if (user.accountInvitations.some((i) => i.status === 'ACCEPTED')) throw new HttpError(409, 'This account has already been activated.');
  if (user.accountInvitations.some((i) => invitationView(i) === 'PENDING')) {
    throw new HttpError(409, 'A pending invitation already exists. Revoke it first, or wait until it expires.');
  }
  if (credentialFingerprint(user.password) !== latest.credentialFingerprint) {
    throw new HttpError(409, "This account's password was set another way, so it cannot be activated by invitation.");
  }
  if (user.status !== 'SUSPENDED') throw new HttpError(409, 'This account is no longer awaiting activation, so it cannot get a new invitation.');

  const issued = await issueCredentials();
  await prisma.$transaction(async (tx) => {
    // Serialize reissues for this account, then re-check under the lock.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    const now = new Date();
    if (await tx.accountInvitation.count({ where: { userId: user.id, status: 'PENDING', expiresAt: { gt: now } } })) {
      throw new HttpError(409, 'A pending invitation already exists. Revoke it first, or wait until it expires.');
    }
    await tx.accountInvitation.updateMany({
      where: { userId: user.id, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: now, revokedReason: 'REISSUED', tempPasswordHash: null },
    });
    await tx.accountInvitation.create({
      data: {
        ...issued.row,
        userId: user.id,
        intendedTier: scope.tier,
        credentialFingerprint: latest.credentialFingerprint,
        teamLabel: latest.teamLabel,
        workspaceId: latest.workspaceId,
        createdById: actorId,
      },
    });
  });
  await logAuditEvent(actorId, 'REISSUE_ACCOUNT_INVITATION', 'USER', user.id, `Reissued the activation invitation of "${user.username}"; expires ${issued.expiresAt.toISOString()}`);
  return { userId: user.id, email: user.email, username: user.username, issued };
};
