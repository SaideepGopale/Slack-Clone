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
 */
export const isAdminUser = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return user?.role === 'ADMIN';
};

export const requireAdmin = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const admin = await isAdminUser(req.user!.id);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });
  next();
};
