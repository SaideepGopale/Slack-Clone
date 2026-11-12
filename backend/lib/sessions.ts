import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { JWT_SECRET } from '../config/env';
import { getSocketServer, kickUserSockets } from '../sockets/registry';
import { prisma } from './prisma';

/**
 * Server-side sessions behind login tokens (T.32, audit H1/H2).
 *
 * Every login JWT carries the id of an AuthSession row as `sid`. A token is
 * accepted (REST `authenticate`, the Socket.IO handshake) only while that row
 * exists, belongs to the token's user, is neither revoked nor expired, and the
 * account is ACTIVE. That makes logout, password changes, bans, suspensions
 * and deletions take effect on the very next request instead of when a
 * 7-day token would naturally expire.
 *
 * The JWT format is otherwise unchanged ({ id, username, role } plus `sid`),
 * signed HS256 with JWT_SECRET. `username`/`role` in the token are never used
 * for authorization: the request identity is refreshed from the database.
 */

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// lastUsedAt is refreshed at most this often per session, so authentication
// costs one indexed read per request and only an occasional write.
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
// Revoked/expired rows are kept this long (session-history display), then pruned.
const RETAIN_ENDED_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  sid: string;
}

export type SessionCheck = { ok: true; user: SessionUser } | { ok: false; error: string };

export const sessionRoom = (sid: string) => `session:${sid}`;

const ENDED = 'Your session has ended. Please sign in again.';

/** Creates a session row and returns the signed login token for it. */
export const issueSession = async (
  user: { id: string; username: string; role: Role },
  meta: { userAgent?: string | null } = {}
): Promise<string> => {
  const sid = randomUUID();
  const now = Date.now();
  await prisma.authSession.create({
    data: {
      id: sid,
      userId: user.id,
      expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000),
      userAgent: typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 255) : null,
    },
  });
  // Housekeeping for this account only; never fails the login.
  prisma.authSession
    .deleteMany({
      where: {
        userId: user.id,
        OR: [{ expiresAt: { lt: new Date(now - RETAIN_ENDED_MS) } }, { revokedAt: { lt: new Date(now - RETAIN_ENDED_MS) } }],
      },
    })
    .catch(() => {});
  return jwt.sign({ id: user.id, username: user.username, role: user.role, sid }, JWT_SECRET as string, {
    algorithm: 'HS256',
    expiresIn: SESSION_TTL_SECONDS,
  });
};

/**
 * Verifies a login token and its session. Never throws for a bad token; only
 * a database failure rejects (callers pass that to their error path).
 */
export const verifySessionToken = async (token: string): Promise<SessionCheck> => {
  let decoded: jwt.JwtPayload;
  try {
    const payload = jwt.verify(token, JWT_SECRET as string, { algorithms: ['HS256'] });
    if (typeof payload !== 'object' || payload === null) return { ok: false, error: ENDED };
    decoded = payload;
  } catch {
    return { ok: false, error: 'Your session is invalid or has expired. Please sign in again.' };
  }

  const { id, sid } = decoded as { id?: unknown; sid?: unknown };
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'Unauthorized: this token does not identify a user.' };
  // Tokens issued before server-side sessions existed carry no sid: they are
  // no longer accepted (one extra sign-in after deployment).
  if (typeof sid !== 'string' || sid.length === 0) return { ok: false, error: ENDED };

  const session = await prisma.authSession.findUnique({
    where: { id: sid },
    select: {
      userId: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      user: { select: { id: true, username: true, role: true, status: true } },
    },
  });
  const now = Date.now();
  if (!session || session.userId !== id || session.revokedAt || session.expiresAt.getTime() <= now) {
    return { ok: false, error: ENDED };
  }
  if (session.user.status !== 'ACTIVE') {
    return { ok: false, error: session.user.status === 'BANNED' ? 'This account has been banned.' : 'This account has been suspended.' };
  }

  if (now - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    prisma.authSession.updateMany({ where: { id: sid, revokedAt: null }, data: { lastUsedAt: new Date(now) } }).catch(() => {});
  }

  return { ok: true, user: { id: session.user.id, username: session.user.username, role: session.user.role, sid } };
};

/** Disconnects every live socket opened with one session. */
const disconnectSessionSockets = (sid: string) => {
  getSocketServer()?.in(sessionRoom(sid)).disconnectSockets(true);
};

/** Ends one session (logout). Idempotent. */
export const revokeSession = async (sid: string, userId?: string) => {
  const result = await prisma.authSession.updateMany({
    where: { id: sid, revokedAt: null, ...(userId ? { userId } : {}) },
    data: { revokedAt: new Date() },
  });
  disconnectSessionSockets(sid);
  return result.count;
};

/**
 * Ends every session of an account, optionally keeping the caller's own
 * (password change). Live sockets of the ended sessions are disconnected.
 */
export const revokeAllSessions = async (userId: string, options: { exceptSid?: string } = {}) => {
  const ended = await prisma.authSession.findMany({
    where: { userId, revokedAt: null, ...(options.exceptSid ? { id: { not: options.exceptSid } } : {}) },
    select: { id: true },
  });
  if (ended.length > 0) {
    await prisma.authSession.updateMany({
      where: { id: { in: ended.map((s) => s.id) }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  if (options.exceptSid) {
    for (const { id } of ended) disconnectSessionSockets(id);
  } else {
    kickUserSockets(userId);
  }
  return ended.length;
};

/** The account's live sessions, newest first (no token material). */
export const listSessions = async (userId: string, currentSid?: string) => {
  const rows = await prisma.authSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    take: 50,
    select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, userAgent: true },
  });
  return rows.map((row) => ({ ...row, current: row.id === currentSid }));
};
