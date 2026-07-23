import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Prisma, Role } from '@prisma/client';
import { JWT_SECRET } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { generateOtp, hashOtp, MAX_OTP_ATTEMPTS, OTP_TTL_MS, verifyOtp as verifyOtpCode } from '../../lib/otp';
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
const signToken = (payload: { id: string; username: string; role: Role }) =>
  jwt.sign(payload, JWT_SECRET as string, { expiresIn: '7d' });

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Channels now belong to a Workspace, so "General" is no longer globally
// unique — a self-serve signup has no "pick a workspace" step yet, so it
// joins the Default Workspace (the one every pre-existing user/channel was
// backfilled into when workspaces were introduced) as a MEMBER, then joins
// that workspace's own "General" channel the same way registration always has.
const joinGeneralChannel = async (tx: Prisma.TransactionClient, userId: string) => {
  const defaultWorkspace = await tx.workspace.findUnique({ where: { slug: DEFAULT_WORKSPACE_SLUG } });
  if (!defaultWorkspace) {
    console.error(`No default workspace (slug="${DEFAULT_WORKSPACE_SLUG}") found — run the workspaces migration/seed first.`);
    return;
  }

  await tx.workspaceMember.upsert({
    where: { userId_workspaceId: { userId, workspaceId: defaultWorkspace.id } },
    update: {},
    create: { userId, workspaceId: defaultWorkspace.id, role: 'MEMBER' },
  });

  const generalChannel = await tx.channel.findFirst({
    where: { name: 'General', isDM: false, workspaceId: defaultWorkspace.id },
  });
  if (!generalChannel) {
    // This deliberately does NOT auto-create it if missing — that's an
    // ops/seeding issue, not something a new account should paper over by
    // spawning a stray channel.
    console.error('No "General" channel found in the default workspace — run reset-to-general-channel.ts to seed it.');
    return;
  }
  await tx.channelMember.upsert({
    where: { userId_channelId: { userId, channelId: generalChannel.id } },
    update: {},
    create: { userId, channelId: generalChannel.id, role: 'member' },
  });
};

/**
 * Step 1 of sign-up: validates input, hashes the password, generates a code,
 * and stores everything in OTPVerification — no `User` row is created here.
 * `email` is `@unique` on that table, so this doubles as the "resend" path:
 * requesting again just replaces the pending code/attempts/expiry.
 */
export const requestSignupOtp = async (username: string, email: string, password: string) => {
  if (!username || !email || !password) {
    throw new HttpError(400, 'username, email and password are required');
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new HttpError(400, 'Invalid email format');
  }
  if (password.length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters long');
  }

  const existingUser = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  if (existingUser) {
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
export const verifySignupOtp = async (email: string, code: string) => {
  if (!email || !code) {
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
  const existingUser = await prisma.user.findFirst({
    where: { OR: [{ email: pending.email }, { username: pending.username }] },
  });
  if (existingUser) {
    await prisma.oTPVerification.delete({ where: { email } }).catch(() => {});
    throw new HttpError(400, 'A user with this email or username already exists.');
  }

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: { username: pending.username, email: pending.email, password: pending.password },
    });

    await joinGeneralChannel(tx, newUser.id);
    await tx.oTPVerification.delete({ where: { email } });

    return newUser;
  });

  const token = signToken({ id: user.id, username: user.username, role: user.role });
  return { token, user: { id: user.id, username: user.username, email: user.email, role: user.role } };
};

export const login = async (email: string, password: string) => {
  if (!email || !password) {
    throw new HttpError(400, 'email and password are required');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new HttpError(401, 'Invalid credentials');
  }
  if (user.status !== 'ACTIVE') {
    throw new HttpError(403, user.status === 'BANNED' ? 'This account has been banned.' : 'This account has been suspended.');
  }

  const token = signToken({ id: user.id, username: user.username, role: user.role });
  return { token, user: { id: user.id, username: user.username, email: user.email, role: user.role } };
};

export const getMe = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true, role: true },
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
  const resetLink = `http://localhost:5174/reset-password?token=${resetToken}&id=${user.id}`;
  await sendResetPasswordEmail(user.email, resetLink);
};

export const forgotPassword = async (email: string) => {
  if (!email) throw new HttpError(400, 'Email is required');

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Don't reveal whether the account exists.
    return { message: 'If an account exists, a password reset link has been sent.' };
  }

  await issuePasswordReset(user);
  return { message: 'Reset email sent successfully' };
};

export const resetPassword = async (id: string, token: string, newPassword: string) => {
  if (!id || !token || !newPassword) {
    throw new HttpError(400, 'Missing required fields');
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new HttpError(404, 'User not found');

  const secret = JWT_SECRET + user.password;
  try {
    jwt.verify(token, secret);
  } catch {
    throw new HttpError(400, 'Invalid or expired reset token. Please request a new one.');
  }

  const hashedPassword = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } });

  return { message: 'Password updated successfully! You can now log in.' };
};

export { HttpError };
