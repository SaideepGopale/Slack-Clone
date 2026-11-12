import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Prisma, Role } from '@prisma/client';
import { APP_URL, JWT_SECRET } from '../../config/env';
import { logAuditEvent } from '../../lib/auditLog';
import { isValidEmail } from '../../lib/email';
import { passwordProblem } from '../../lib/passwordPolicy';
import { prisma } from '../../lib/prisma';
import { issueSession, revokeAllSessions } from '../../lib/sessions';
import { generateOtp, hashOtp, MAX_OTP_ATTEMPTS, OTP_TTL_MS, verifyOtp as verifyOtpCode } from '../../lib/otp';
import { hasLiveInvitation, hasSignupConflict, lockSignupEmail, rethrowAsDuplicateAccount } from '../../lib/signupEmail';
import { INVITE_ONLY_MESSAGE } from '../../middleware/inviteOnlySignup.middleware';
import { sendOtpEmail, sendResetPasswordEmail } from '../../utils/mailer';
import { DEFAULT_WORKSPACE_SLUG } from '../workspaces/workspaces.service';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// `role` rides in the JWT so the client can decide whether to show admin UI
// without a round-trip — but it's never trusted as the *authorization*
// decision itself. Every admin-gated route re-checks the database via
// requireAdmin (middleware/admin.middleware.ts), since a role change or a ban
// must take effect before a 7-day-old token naturally expires.
//
// T.32 (audit H1): login tokens are issued with a server-side session
// (lib/sessions.ts issueSession) so they can be revoked before they expire.
type SessionMeta = { userAgent?: string | null };

const isFilledString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isMissing = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Sign-up field rules shared by both sign-up paths. T.32 (audit M3): values
 * of the wrong type are a 400 with the same messages as before (an e-mail
 * that is not a string is an invalid e-mail), never a 500 from Prisma/bcrypt.
 */
const validateSignupFields = (username: unknown, email: unknown, password: unknown) => {
  if (isMissing(username) || isMissing(email) || isMissing(password)) {
    throw new HttpError(400, 'username, email and password are required');
  }
  if (typeof email !== 'string' || !isValidEmail(email)) throw new HttpError(400, 'Invalid email format');
  if (typeof username !== 'string' || username.trim().length === 0) throw new HttpError(400, 'Username must be text.');
  if (username.length > 64) throw new HttpError(400, 'Username must be at most 64 characters long');
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  return { username, email, password: password as string };
};

// T.32 (audit M4): login runs bcrypt even for an unknown address, so response
// time does not reveal which addresses have accounts. Computed once, lazily.
let timingEqualiserHash: Promise<string> | null = null;
const equaliseLoginTiming = (password: string) => {
  timingEqualiserHash ??= bcrypt.hash('smartconnect-timing-equaliser', 12);
  return timingEqualiserHash.then((hash) => bcrypt.compare(password, hash)).then(() => false);
};

// E-mail format: isValidEmail (lib/email.ts) caps the length before the
// pattern runs — the pattern alone could block the event loop (FA-SEC-02).

// Channels now belong to a Workspace, so "General" is no longer globally
// unique — a self-serve signup has no "pick a workspace" step yet, so it
// joins the Default Workspace (the one every pre-existing user/channel was
// backfilled into when workspaces were introduced) as a MEMBER, then joins
// that workspace's own "General" channel the same way registration always has.
// Returns the default workspace's id (so callers can hand it straight back
// to the client as "where to land this user"), or null on either bail-out
// path below.
const joinGeneralChannel = async (tx: Prisma.TransactionClient, userId: string): Promise<string | null> => {
  const defaultWorkspace = await tx.workspace.findUnique({ where: { slug: DEFAULT_WORKSPACE_SLUG } });
  if (!defaultWorkspace) {
    console.error(`No default workspace (slug="${DEFAULT_WORKSPACE_SLUG}") found — run the workspaces migration/seed first.`);
    return null;
  }

  await tx.workspaceMember.upsert({
    where: { userId_workspaceId: { userId, workspaceId: defaultWorkspace.id } },
    update: {},
    create: { userId, workspaceId: defaultWorkspace.id, role: 'MEMBER' },
  });

  // A brand-new signup's only workspace — set as their landing page from
  // the start, same field WorkspaceLayout.tsx keeps updated afterward on
  // every subsequent workspace switch.
  await tx.user.update({ where: { id: userId }, data: { lastActiveWorkspaceId: defaultWorkspace.id } });

  const generalChannel = await tx.channel.findFirst({
    where: { name: 'General', isDM: false, workspaceId: defaultWorkspace.id },
  });
  if (!generalChannel) {
    // This deliberately does NOT auto-create it if missing — that's an
    // ops/seeding issue, not something a new account should paper over by
    // spawning a stray channel.
    console.error('No "General" channel found in the default workspace — the workspace setup is incomplete (every workspace is created with one).');
    return defaultWorkspace.id;
  }
  await tx.channelMember.upsert({
    where: { userId_channelId: { userId, channelId: generalChannel.id } },
    update: {},
    create: { userId, channelId: generalChannel.id, role: 'member' },
  });

  return defaultWorkspace.id;
};

/**
 * Direct, single-step signup — creates the account immediately with no
 * email/OTP round-trip. Added as a stopgap while email delivery isn't
 * reliably reachable in production (see mailer.ts); the OTP flow below
 * (requestSignupOtp/verifySignupOtp) is left fully intact and still works
 * once that's resolved, this just isn't the path AuthForm.tsx calls right
 * now. Same validation/hashing/default-workspace-join as the OTP path's
 * second step, minus the email round-trip.
 */
export const signup = async (rawUsername: unknown, rawEmail: unknown, rawPassword: unknown, meta: SessionMeta = {}) => {
  const { username, email, password } = validateSignupFields(rawUsername, rawEmail, rawPassword);

  // Stage 6A (AUTH-1): the address matches in any letter case (lib/signupEmail.ts).
  if (await hasSignupConflict(prisma, email, username)) {
    throw new HttpError(400, 'A user with this email or username already exists');
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const user = await prisma.$transaction(async (tx) => {
    // Re-checked under a per-address lock: concurrent sign-ups for one
    // address (any letter case) create exactly one account.
    await lockSignupEmail(tx, email);
    if (await hasSignupConflict(tx, email, username)) {
      throw new HttpError(400, 'A user with this email or username already exists');
    }
    // Stage 6C (R1): the invitation the gate accepted must still be live — held until commit.
    if (!(await hasLiveInvitation(tx, email))) throw new HttpError(403, INVITE_ONLY_MESSAGE);
    const newUser = await tx.user.create({ data: { username, email, password: hashedPassword } });
    const defaultWorkspaceId = await joinGeneralChannel(tx, newUser.id);
    return { ...newUser, lastActiveWorkspaceId: defaultWorkspaceId };
  }).catch(rethrowAsDuplicateAccount('A user with this email or username already exists'));

  const token = await issueSession({ id: user.id, username: user.username, role: user.role }, meta);
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      lastActiveWorkspaceId: user.lastActiveWorkspaceId,
    },
  };
};

/**
 * Step 1 of sign-up: validates input, hashes the password, generates a code,
 * and stores everything in OTPVerification — no `User` row is created here.
 * `email` is `@unique` on that table, so this doubles as the "resend" path:
 * requesting again just replaces the pending code/attempts/expiry.
 */
export const requestSignupOtp = async (rawUsername: unknown, rawEmail: unknown, rawPassword: unknown) => {
  const { username, email, password } = validateSignupFields(rawUsername, rawEmail, rawPassword);

  // Stage 6A (AUTH-1): any letter case. Early answer only — verifySignupOtp
  // re-checks under the per-address lock when it creates the account.
  if (await hasSignupConflict(prisma, email, username)) {
    throw new HttpError(400, 'A user with this email or username already exists');
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const code = generateOtp();
  const otpHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  // sendOtpEmail throws if it can't actually deliver the code — better to
  // fail the request outright than store a pending signup the user has no
  // way to complete.
  await sendOtpEmail(email, code);

  await prisma.oTPVerification.upsert({
    where: { email },
    update: { username, password: hashedPassword, otpHash, attempts: 0, expiresAt },
    create: { email, username, password: hashedPassword, otpHash, expiresAt },
  });

  return { message: 'Verification code sent to your email.', expiresAt };
};

/**
 * Step 2: checks the code (expiry, attempt cap, timing-safe hash compare),
 * and only on success actually creates the `User` row, joins General, and
 * removes the OTPVerification record — all inside one transaction.
 */
export const verifySignupOtp = async (email: unknown, code: unknown, meta: SessionMeta = {}) => {
  if (!isFilledString(email) || !isFilledString(code)) {
    throw new HttpError(400, 'email and code are required');
  }

  const pending = await prisma.oTPVerification.findUnique({ where: { email } });
  if (!pending) {
    throw new HttpError(400, 'No pending verification for this email. Request a new code.');
  }

  if (pending.expiresAt.getTime() < Date.now()) {
    await prisma.oTPVerification.delete({ where: { email } }).catch(() => {});
    throw new HttpError(400, 'This code has expired. Request a new one.');
  }

  if (pending.attempts >= MAX_OTP_ATTEMPTS) {
    await prisma.oTPVerification.delete({ where: { email } }).catch(() => {});
    throw new HttpError(429, 'Too many incorrect attempts. Request a new code.');
  }

  if (!verifyOtpCode(code, pending.otpHash)) {
    const attemptsNow = pending.attempts + 1;
    if (attemptsNow >= MAX_OTP_ATTEMPTS) {
      await prisma.oTPVerification.delete({ where: { email } });
      throw new HttpError(429, 'Too many incorrect attempts. Request a new code.');
    }
    await prisma.oTPVerification.update({ where: { email }, data: { attempts: { increment: 1 } } });
    throw new HttpError(400, `Incorrect code. ${MAX_OTP_ATTEMPTS - attemptsNow} attempt(s) remaining.`);
  }

  // Re-check uniqueness: someone could have registered this exact
  // email/username directly in the window since the code was requested.
  // Stage 6A (AUTH-1): any letter case (lib/signupEmail.ts).
  if (await hasSignupConflict(prisma, pending.email, pending.username)) {
    await prisma.oTPVerification.delete({ where: { email } }).catch(() => {});
    throw new HttpError(400, 'A user with this email or username already exists.');
  }

  const user = await prisma.$transaction(async (tx) => {
    // Re-checked under the per-address lock shared with direct sign-up.
    await lockSignupEmail(tx, pending.email);
    if (await hasSignupConflict(tx, pending.email, pending.username)) {
      throw new HttpError(400, 'A user with this email or username already exists.');
    }
    // Stage 6C (R1): the invitation the gate accepted must still be live — held until commit.
    if (!(await hasLiveInvitation(tx, pending.email))) throw new HttpError(403, INVITE_ONLY_MESSAGE);
    const newUser = await tx.user.create({
      data: { username: pending.username, email: pending.email, password: pending.password },
    });

    const defaultWorkspaceId = await joinGeneralChannel(tx, newUser.id);
    await tx.oTPVerification.delete({ where: { email } });

    return { ...newUser, lastActiveWorkspaceId: defaultWorkspaceId };
  }).catch(rethrowAsDuplicateAccount('A user with this email or username already exists.'));

  const token = await issueSession({ id: user.id, username: user.username, role: user.role }, meta);
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      lastActiveWorkspaceId: user.lastActiveWorkspaceId,
    },
  };
};

export const login = async (email: unknown, password: unknown, meta: SessionMeta = {}) => {
  if (!isFilledString(email) || !isFilledString(password)) {
    throw new HttpError(400, 'email and password are required');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const passwordOk = user ? await bcrypt.compare(password, user.password) : await equaliseLoginTiming(password);
  if (!user || !passwordOk) {
    throw new HttpError(401, 'Invalid credentials');
  }
  if (user.status !== 'ACTIVE') {
    throw new HttpError(403, user.status === 'BANNED' ? 'This account has been banned.' : 'This account has been suspended.');
  }

  const token = await issueSession({ id: user.id, username: user.username, role: user.role }, meta);
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      lastActiveWorkspaceId: user.lastActiveWorkspaceId,
    },
  };
};

export const getMe = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true, role: true, lastActiveWorkspaceId: true },
  });
  if (!user) throw new HttpError(404, 'User not found');
  return user;
};

// Shared by self-service forgotPassword below and the admin "force reset"
// action (admin.service.ts) — issues a one-time reset link and emails it.
// Appending the current password hash to the JWT secret makes the link
// self-invalidating: the moment the password actually changes, every
// previously issued link (including any the admin generated) stops verifying.
export const issuePasswordReset = async (user: { id: string; email: string; password: string }) => {
  const secret = JWT_SECRET + user.password;
  const resetToken = jwt.sign({ id: user.id }, secret, { expiresIn: '15m' });
  // The frontend's /reset-password page, at the configured frontend origin (APP_URL).
  const resetLink = `${APP_URL}/reset-password?token=${resetToken}&id=${user.id}`;
  await sendResetPasswordEmail(user.email, resetLink);
};

// T.32 (audit M1): one answer whether or not the address has an account, so
// this endpoint cannot be used to discover accounts (it is rate limited too).
const FORGOT_PASSWORD_REPLY = { message: 'If an account exists for that address, a password reset link has been sent.' };

export const forgotPassword = async (email: unknown) => {
  if (!isFilledString(email)) throw new HttpError(400, 'Email is required');
  if (!isValidEmail(email)) return FORGOT_PASSWORD_REPLY;

  const user = await prisma.user.findUnique({ where: { email } });
  // A reset never grants access by itself: a suspended or banned account
  // still cannot sign in afterwards (tests/stage2-team-leads.test.ts).
  if (!user) return FORGOT_PASSWORD_REPLY;

  await issuePasswordReset(user);
  return FORGOT_PASSWORD_REPLY;
};

const INVALID_RESET_LINK = 'Invalid or expired reset link. Please request a new one.';

/**
 * Completes a reset. T.32: the same 400 for an unknown account as for a bad
 * token (no account discovery), the shared password policy, and — audit H1 —
 * every existing session of the account is ended, so a stolen token or an
 * old device does not survive the reset.
 */
export const resetPassword = async (id: unknown, token: unknown, newPassword: unknown) => {
  if (!isFilledString(id) || !isFilledString(token) || newPassword === undefined || newPassword === null || newPassword === '') {
    throw new HttpError(400, 'Missing required fields');
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw new HttpError(400, problem);

  const user = await prisma.user.findUnique({ where: { id } }).catch(() => null);
  if (!user) throw new HttpError(400, INVALID_RESET_LINK);

  const secret = JWT_SECRET + user.password;
  try {
    jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    throw new HttpError(400, INVALID_RESET_LINK);
  }

  const hashedPassword = await bcrypt.hash(newPassword as string, 12);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } });
  const ended = await revokeAllSessions(user.id);
  await logAuditEvent(user.id, 'RESET_PASSWORD', 'USER', user.id, `Reset their password with an e-mailed link (${ended} session(s) ended)`);

  return { message: 'Password updated successfully! You can now log in.' };
};

/**
 * POST /api/auth/change-password — a signed-in user changes their own
 * password. The current password is required; every OTHER session of the
 * account is ended (this one stays signed in).
 */
export const changePassword = async (userId: string, sid: string | undefined, currentPassword: unknown, newPassword: unknown) => {
  if (!isFilledString(currentPassword) || newPassword === undefined || newPassword === null || newPassword === '') {
    throw new HttpError(400, 'currentPassword and newPassword are required');
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw new HttpError(400, problem);
  if (currentPassword === newPassword) throw new HttpError(400, 'Choose a password different from your current one.');

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, password: true } });
  if (!user) throw new HttpError(404, 'User not found');
  if (!(await bcrypt.compare(currentPassword, user.password))) {
    throw new HttpError(400, 'Your current password is incorrect.');
  }

  await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(newPassword as string, 12) } });
  const ended = await revokeAllSessions(user.id, { exceptSid: sid });
  await logAuditEvent(user.id, 'CHANGE_PASSWORD', 'USER', user.id, `Changed their password (${ended} other session(s) ended)`);
  return { message: 'Password changed. Other devices have been signed out.', endedSessions: ended };
};

export { HttpError };
