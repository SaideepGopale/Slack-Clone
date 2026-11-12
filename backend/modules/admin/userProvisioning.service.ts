import bcrypt from 'bcryptjs';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { findLoginOrUsernameClash } from '../../lib/identity';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import { ensureSharedWorkspaceMembership, SYSTEM_USER_EMAIL } from '../../lib/sharedWorkspace';
import { revokeAllSessions } from '../../lib/sessions';

/**
 * Platform user provisioning (P2). Every route that calls these sits behind
 * the admin router's authenticate + requireAdmin (DB role re-check), so only
 * platform administrators reach them. Workspace administrators never do.
 *
 * Accounts are created immediately with a login identifier and password the
 * admin chooses — no e-mail, OTP or invitation link. The login identifier is
 * stored in User.email, which is what login looks up, so it may be an e-mail
 * address or any other identifier such as "sam@2003".
 */

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,38}[A-Za-z0-9]$/; // 3–40 characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PASSWORD_MIN = 6; // the application's existing password rule (signup), unchanged
const PASSWORD_MAX = 128;
const LOGIN_MIN = 3;
const LOGIN_MAX = 254;
const DISPLAY_NAME_MAX = 80;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
// Internal accounts that own platform resources or deleted users' content.
const RESERVED_LOGINS = [SYSTEM_USER_EMAIL, 'deleted-user@system.internal'];
const CREATABLE_STATUSES: UserStatus[] = ['ACTIVE', 'SUSPENDED'];

// Explicit selection: password hashes are never read into a response.
const ADMIN_USER_SELECT = {
  id: true,
  username: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  profile: { select: { displayName: true } },
  _count: { select: { workspaces: true } },
} satisfies Prisma.UserSelect;

type AdminUserRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>;

const toAdminUser = (user: AdminUserRow) => ({
  id: user.id,
  username: user.username,
  loginId: user.email,
  displayName: user.profile?.displayName ?? null,
  role: user.role,
  status: user.status,
  createdAt: user.createdAt,
  workspaceCount: user._count.workspaces,
});

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const parseUsername = (value: unknown) => {
  const username = text(value);
  if (!USERNAME.test(username)) {
    throw new HttpError(400, 'Username must be 3–40 characters: letters, numbers, ".", "_" or "-", starting and ending with a letter or number.');
  }
  return username;
};

const parseLoginId = (value: unknown) => {
  const loginId = text(value);
  if (loginId.length < LOGIN_MIN || loginId.length > LOGIN_MAX || /\s/.test(loginId) || CONTROL_CHARS.test(loginId)) {
    throw new HttpError(400, `Login must be ${LOGIN_MIN}–${LOGIN_MAX} characters with no spaces.`);
  }
  if (RESERVED_LOGINS.includes(loginId.toLowerCase())) throw new HttpError(400, 'That login is reserved.');
  return loginId;
};

const parsePassword = (value: unknown) => {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw new HttpError(400, `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
  }
  return value;
};

const parseDisplayName = (value: unknown) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Display name must be text.');
  const displayName = value.trim();
  if (CONTROL_CHARS.test(displayName)) throw new HttpError(400, 'Display name contains invalid characters.');
  if (displayName.length > DISPLAY_NAME_MAX) throw new HttpError(400, `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`);
  return displayName || null;
};

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** POST /api/admin/users — create an account that can log in immediately. */
export const createUser = async (adminId: string, body: Record<string, unknown> | undefined) => {
  const username = parseUsername(body?.username);
  const loginId = parseLoginId(body?.loginId);
  const password = parsePassword(body?.password);
  const displayName = parseDisplayName(body?.displayName);
  const status = (body?.status ?? 'ACTIVE') as UserStatus;
  if (!CREATABLE_STATUSES.includes(status)) throw new HttpError(400, 'Initial status must be ACTIVE or SUSPENDED.');

  // Stage 6C (IDN-3): exact and case-insensitive, as before minus the wildcards —
  // "_", "%" and "\" in a login or username are ordinary characters.
  const clash = await findLoginOrUsernameClash(prisma, loginId, username);
  if (clash) {
    throw new HttpError(409, clash.username.toLowerCase() === username.toLowerCase() ? 'That username is already taken.' : 'An account with that login already exists.');
  }

  let user: AdminUserRow;
  try {
    user = await prisma.user.create({
      data: {
        username,
        email: loginId,
        password: await bcrypt.hash(password, 12), // the existing hashing (auth.service): bcrypt, cost 12
        role: 'USER',
        status,
        ...(displayName ? { profile: { create: { displayName } } } : {}),
      },
      select: ADMIN_USER_SELECT,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'An account with that username or login already exists.');
    throw err;
  }
  await logAuditEvent(adminId, 'CREATE_USER', 'USER', user.id, `Created user "${user.username}" (login ${user.email}, ${user.status})`);
  if (user.status === 'ACTIVE') await ensureSharedWorkspaceMembership(user.id);
  return toAdminUser(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: ADMIN_USER_SELECT }));
};

/** GET /api/admin/users?q=&status=&role=&cursor=&limit= — server-side search, newest first. */
export const listUsers = async (query: Record<string, unknown>) => {
  const q = text(query.q).slice(0, 100);
  const status = Object.values(UserStatus).includes(query.status as UserStatus) ? (query.status as UserStatus) : undefined;
  const role = Object.values(Role).includes(query.role as Role) ? (query.role as Role) : undefined;
  const take = Math.min(Math.max(Number(query.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
  const cursor = isUuid(query.cursor) ? query.cursor : undefined;

  const rows = await prisma.user.findMany({
    where: {
      email: { notIn: RESERVED_LOGINS },
      ...(status ? { status } : {}),
      ...(role ? { role } : {}),
      ...(q
        ? {
            OR: [
              { username: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
              { profile: { displayName: { contains: q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    },
    select: ADMIN_USER_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  return { users: page.map(toAdminUser), nextCursor: rows.length > take ? page[page.length - 1].id : null };
};

const loadManageableUser = async (userId: unknown) => {
  if (!isUuid(userId)) throw new HttpError(404, 'User not found.');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, email: true } });
  if (!user) throw new HttpError(404, 'User not found.');
  if (RESERVED_LOGINS.includes(user.email.toLowerCase())) throw new HttpError(403, 'System accounts cannot be changed here.');
  return user;
};

/** GET /api/admin/users/:id — account details, who created it, and workspace memberships. */
export const getUserDetails = async (userId: unknown) => {
  const target = await loadManageableUser(userId);
  const [user, memberships, created] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: target.id }, select: ADMIN_USER_SELECT }),
    prisma.workspaceMember.findMany({
      where: { userId: target.id },
      select: { role: true, createdAt: true, workspace: { select: { id: true, name: true, isDefault: true, ownerId: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.auditLog.findFirst({
      where: { action: 'CREATE_USER', targetType: 'USER', targetId: target.id },
      select: { createdAt: true, actor: { select: { username: true } } },
    }),
  ]);
  return {
    ...toAdminUser(user),
    createdBy: created ? created.actor.username : null, // null: self-registered (or before provisioning existed)
    workspaces: memberships.map((m) => ({
      workspaceId: m.workspace.id,
      name: m.workspace.name,
      shared: m.workspace.isDefault,
      role: m.workspace.ownerId === target.id ? 'OWNER' : m.role,
      joinedAt: m.createdAt,
    })),
  };
};

/** PATCH /api/admin/users/:id/profile { displayName } — the profile fields an admin may edit. */
export const updateUserProfile = async (adminId: string, userId: unknown, body: Record<string, unknown> | undefined) => {
  const target = await loadManageableUser(userId);
  const displayName = parseDisplayName(body?.displayName);
  await prisma.userProfile.upsert({
    where: { userId: target.id },
    update: { displayName },
    create: { userId: target.id, displayName },
  });
  await logAuditEvent(adminId, 'UPDATE_USER', 'USER', target.id, `Updated the display name of "${target.username}"`);
  return getUserDetails(target.id);
};

/**
 * POST /api/admin/users/:id/password { password } — set a new password for an
 * account (internal testing has no e-mail delivery). The account's live
 * sockets are disconnected so it signs in again with the new password.
 */
export const setUserPassword = async (adminId: string, userId: unknown, body: Record<string, unknown> | undefined) => {
  if (adminId === userId) throw new HttpError(400, 'You cannot reset your own password here.');
  const target = await loadManageableUser(userId);
  const password = parsePassword(body?.password);
  await prisma.user.update({ where: { id: target.id }, data: { password: await bcrypt.hash(password, 12) } });
  // T.32 (audit H1): every existing session of the account ends (and its sockets disconnect).
  await revokeAllSessions(target.id);
  await logAuditEvent(adminId, 'SET_USER_PASSWORD', 'USER', target.id, `Set a new password for "${target.username}"`);
  return { updated: true };
};
