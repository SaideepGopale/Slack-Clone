import { NextFunction, Response } from 'express';
import { authenticate, AuthenticatedRequest } from './auth.middleware';

/**
 * Post-authentication guard for collaboration routes (authorization layer —
 * `authenticate` itself is intentionally left untouched).
 *
 * `authenticate` accepts any JWT signed with JWT_SECRET. Workspace invite
 * links used to be JWTs signed with that same secret but carrying only
 * `{ workspaceId }`, so such a token produced `req.user.id === undefined`.
 * Prisma treats an undefined filter value as "no filter", which turned
 * user-scoped list queries into "everyone's data" (audit SEC-01). Every
 * collaboration route therefore requires a concrete user id before any
 * service runs, failing closed with 401.
 */
export const requireUserIdentity = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const id = req.user?.id;
  if (typeof id !== 'string' || id.length === 0) {
    return res.status(401).json({ error: 'Unauthorized: this token does not identify a user.' });
  }
  next();
};

/** `authenticate` followed by the identity guard — use on every collaboration route. */
export const requireSessionUser = [authenticate, requireUserIdentity];
