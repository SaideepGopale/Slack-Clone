import { Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest } from './auth.middleware';

/**
 * Single source of truth for "is this user an admin" — the unified `role`
 * column on `User`. Replaces the old email heuristic
 * (`email === 'admin@slack.com' || email.includes('admin@')`) and the
 * separate hardcoded-credential admin-login JWT claim, which disagreed with
 * each other and with this check.
 *
 * Always re-queries the database rather than trusting a role claim embedded
 * in the caller's JWT: a JWT can be up to 7 days old, and an admin who's been
 * demoted (or a banned account) must lose access immediately, not at their
 * token's natural expiry.
 *
 * T.32 (audit H2): the account must also be ACTIVE — a suspended or banned
 * admin is not an admin (authenticate already refuses such sessions; this is
 * the same rule for every other caller, e.g. the admin socket handlers).
 */
export const isAdminUser = async (userId: string): Promise<boolean> => {
  if (typeof userId !== 'string' || userId.length === 0) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true },
  });
  return user?.role === 'ADMIN' && user.status === 'ACTIVE';
};

// T.32 (audit M2): async errors reach the error handler instead of leaving the
// request hanging (Express 4 does not await middleware promises). The returned
// promise never rejects, so existing `requireAdmin(...).catch(next)` wrappers
// (teamManagement, companyOverview routes) keep working unchanged.
export const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  return isAdminUser(req.user?.id ?? '').then((admin) => {
    if (!admin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  }, next);
};
