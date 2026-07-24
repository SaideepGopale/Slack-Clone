import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { issuePasswordReset } from '../auth/auth.service';
import { kickUserSockets } from '../../sockets/registry';
import { toCsv } from '../../utils/csv';
import { logAuditEvent } from '../../lib/auditLog';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const getAdminStats = async () => {
  const [totalUsers, totalChannels, totalMessages, users] = await Promise.all([
    prisma.user.count(),
    prisma.channel.count(),
    prisma.message.count(),
    prisma.user.findMany({
      select: { id: true, username: true, email: true, role: true, status: true, createdAt: true },
    }),
  ]);

  return { totalUsers, totalChannels, totalMessages, users };
};

const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (d: Date) => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

export const getAnalytics = async () => {
  const today = startOfDay(new Date());
  const sevenDaysAgo = new Date(today.getTime() - 6 * DAY_MS);

  const [totalUsers, totalChannels, totalMessages, dailyRows, nonDmChannels] = await Promise.all([
    prisma.user.count(),
    prisma.channel.count({ where: { isDM: false } }),
    prisma.message.count(),
    // date_trunc groups messages by calendar day server-side — Prisma's
    // groupBy only supports equality grouping on raw columns, not date
    // truncation, so a raw aggregate query is the correct tool here.
    prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
      FROM "Message"
      WHERE "createdAt" >= ${sevenDaysAgo}
      GROUP BY day
      ORDER BY day ASC
    `,
    // groupBy can't filter on a *related* model's column (Message has no
    // isDM of its own), so the non-DM channel ID list is fetched first and
    // used as an `in` filter below — otherwise DM conversations (which have
    // no real `name`) would compete for "most active channel".
    prisma.channel.findMany({ where: { isDM: false }, select: { id: true, name: true } }),
  ]);

  const topChannelsGrouped = await prisma.message.groupBy({
    by: ['channelId'],
    where: { channelId: { in: nonDmChannels.map((c) => c.id) } },
    _count: { channelId: true },
    orderBy: { _count: { channelId: 'desc' } },
    take: 3,
  });

  // Zero-fill every day in the window — Recharts needs a stable 7-point
  // x-axis, not just the days that happened to have messages.
  const countByDay = new Map(dailyRows.map((r) => [startOfDay(r.day).getTime(), Number(r.count)]));
  const messagesPerDay = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(sevenDaysAgo.getTime() + i * DAY_MS);
    return { date: DAY_ABBREVIATIONS[day.getDay()], count: countByDay.get(day.getTime()) ?? 0 };
  });

  const nameById = new Map(nonDmChannels.map((c) => [c.id, c.name]));
  const topChannels = topChannelsGrouped.map((g) => ({
    id: g.channelId,
    name: nameById.get(g.channelId) ?? 'Unknown',
    messageCount: g._count.channelId,
  }));

  return { totalUsers, totalChannels, totalMessages, messagesPerDay, topChannels };
};

export const exportUsersCsv = async () => {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, email: true, role: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  return toCsv(users, [
    { key: 'id', header: 'ID' },
    { key: 'username', header: 'Username' },
    { key: 'email', header: 'Email' },
    { key: 'role', header: 'Role' },
    { key: 'status', header: 'Status' },
    { key: 'createdAt', header: 'Created At' },
  ]);
};

export const exportChannelsCsv = async () => {
  const channels = await prisma.channel.findMany({
    where: { isDM: false },
    include: { _count: { select: { members: true, messages: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const rows = channels.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    memberCount: c._count.members,
    messageCount: c._count.messages,
    createdAt: c.createdAt,
  }));

  return toCsv(rows, [
    { key: 'id', header: 'ID' },
    { key: 'name', header: 'Name' },
    { key: 'description', header: 'Description' },
    { key: 'memberCount', header: 'Members' },
    { key: 'messageCount', header: 'Messages' },
    { key: 'createdAt', header: 'Created At' },
  ]);
};

const AUDIT_LOG_PAGE_SIZE = 50;

// Same cursor-pagination shape as messages.service.ts's getChannelMessages —
// id as a tiebreaker after createdAt since two log entries can land in the
// same millisecond under a burst of admin actions, and take+1 avoids a
// separate COUNT query just to report hasMore.
export const getAuditLogs = async (cursor?: string) => {
  const take = AUDIT_LOG_PAGE_SIZE;

  const rows = await prisma.auditLog.findMany({
    include: { actor: { select: { id: true, username: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const logs = rows.slice(0, take);
  const nextCursor = hasMore ? logs[logs.length - 1].id : null;

  return { logs, nextCursor, hasMore };
};

const DELETED_USER_EMAIL = 'deleted-user@system.internal';

// The account real messages/channels get reattributed to when their owner is
// permanently deleted, so message history and channel attribution survive
// the deletion instead of violating the RESTRICT constraints on
// Message.senderId / Channel.createdBy (see schema.prisma comments). Created
// lazily on first use, then reused (looked up by its fixed, reserved email).
// It can never log in for real: the password is a random hash nobody knows,
// and it's also flagged status: BANNED as a second line of defense.
const getOrCreateDeletedUserSentinel = async (tx: Prisma.TransactionClient) => {
  const existing = await tx.user.findUnique({ where: { email: DELETED_USER_EMAIL } });
  if (existing) return existing;

  const randomPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  return tx.user.create({
    data: {
      username: 'deleted_user',
      email: DELETED_USER_EMAIL,
      password: randomPassword,
      status: 'BANNED',
    },
  });
};

// Note on scope: this deliberately does NOT include a "can't remove the last
// admin" count check. Every caller of this function already passed
// `requireAdmin` (so the caller is a real admin) and is blocked from acting
// on themselves above — which means whenever `target.role === 'ADMIN'` here,
// the caller and target are two *distinct* admins, so at least one admin
// always survives the action. A same-admin-count guard would be checking a
// condition that can never be true through these routes; adding it would be
// defending against a scenario this code can't reach, not real protection.
const assertCanModerate = async (adminId: string, targetUserId: string, action: string) => {
  if (adminId === targetUserId) {
    throw new HttpError(400, `You cannot ${action} your own account.`);
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new HttpError(404, 'User not found.');

  return target;
};

const VALID_STATUSES: string[] = Object.values(UserStatus);

// The "Enforcer" status-update action: suspend, ban, or reinstate a user.
// Kicks their active sockets immediately when moving them off ACTIVE — an
// admin acting on a currently-connected troublemaker shouldn't have to wait
// for that person's token to expire or their client to reconnect.
export const updateUserStatus = async (adminId: string, targetUserId: string, status: string) => {
  if (!VALID_STATUSES.includes(status)) {
    throw new HttpError(400, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const target = await assertCanModerate(adminId, targetUserId, 'change the status of');

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { status: status as UserStatus },
    select: { id: true, username: true, status: true },
  });

  if (updated.status !== 'ACTIVE') {
    kickUserSockets(updated.id);
  }

  const auditAction = updated.status === 'BANNED' ? 'BAN_USER' : updated.status === 'SUSPENDED' ? 'SUSPEND_USER' : 'REACTIVATE_USER';
  await logAuditEvent(adminId, auditAction, 'USER', target.id, `${auditAction === 'REACTIVATE_USER' ? 'Reactivated' : auditAction === 'BAN_USER' ? 'Banned' : 'Suspended'} user "${target.username}" (was ${target.status})`);

  return updated;
};

// Backward-compatible wrapper for the original POST /users/:id/ban route —
// existing admin-panel UI still calls this; new code should hit
// PATCH /users/:id/status directly for the full ACTIVE/SUSPENDED/BANNED range.
export const banUser = (adminId: string, targetUserId: string) =>
  updateUserStatus(adminId, targetUserId, 'BANNED');

// Toggles between USER and ADMIN. Blocked on self for the same reason
// assertCanModerate blocks self-moderation generally: an admin demoting
// themselves could strand the workspace with a role change nobody but
// another admin can undo — so it always has to be another admin doing it.
export const toggleUserRole = async (adminId: string, targetUserId: string) => {
  const target = await assertCanModerate(adminId, targetUserId, 'change the role of');

  const newRole: Role = target.role === 'ADMIN' ? 'USER' : 'ADMIN';
  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { role: newRole },
    select: { id: true, username: true, role: true },
  });

  await logAuditEvent(adminId, 'CHANGE_ROLE', 'USER', target.id, `Changed role of "${target.username}" from ${target.role} to ${newRole}`);

  return updated;
};

// Lets an admin trigger the same reset-link flow a user would normally
// request themselves via "Forgot password" — useful when a user is locked
// out and can't reach that flow on their own. Reuses issuePasswordReset
// (auth.service.ts) rather than duplicating the token/email logic.
export const forceResetPassword = async (adminId: string, targetUserId: string) => {
  const target = await assertCanModerate(adminId, targetUserId, 'reset the password for');
  await issuePasswordReset(target);
  await logAuditEvent(adminId, 'FORCE_PASSWORD_RESET', 'USER', target.id, `Forced a password reset for "${target.username}"`);
  return { message: `Password reset email sent to ${target.email}.` };
};

export const deleteUser = async (adminId: string, targetUserId: string) => {
  const target = await assertCanModerate(adminId, targetUserId, 'delete');

  await prisma.$transaction(async (tx) => {
    const sentinel = await getOrCreateDeletedUserSentinel(tx);

    // Reassign content that must survive the user's removal. ChannelMember
    // and Invitation rows cascade-delete automatically (see schema.prisma) —
    // membership/invite records have no meaning without the member.
    await tx.message.updateMany({ where: { senderId: targetUserId }, data: { senderId: sentinel.id } });
    await tx.channel.updateMany({ where: { createdBy: targetUserId }, data: { createdBy: sentinel.id } });
    // If this user was ever an admin, their own past audit log entries must
    // survive too — same RESTRICT reasoning as messages/channels above.
    await tx.auditLog.updateMany({ where: { actorId: targetUserId }, data: { actorId: sentinel.id } });

    await tx.user.delete({ where: { id: targetUserId } });
  });

  await logAuditEvent(adminId, 'DELETE_USER', 'USER', targetUserId, `Deleted user "${target.username}" (${target.email})`);

  return { message: 'User deleted successfully' };
};

export { HttpError };
