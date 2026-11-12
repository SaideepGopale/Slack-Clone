import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { verifySessionToken } from '../lib/sessions';

export interface AuthenticatedRequest extends Request {
  // `sid` is the server-side session behind the token (lib/sessions.ts).
  user?: { id: string; username: string; role: Role; sid?: string };
}

/**
 * T.32 (audit H1): a token is accepted only while its server-side session is
 * live and the account is ACTIVE — checked against the database on every
 * request, so logout, password changes, bans, suspensions and deletions take
 * effect immediately. `req.user` is the database identity (fresh username and
 * role), never the claims embedded in the token.
 *
 * Every authentication failure is 401 (missing, malformed, expired, revoked,
 * or an account that is no longer active): the client's single signal that
 * the session is over. 403 remains "signed in, but not allowed".
 */
export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token === 'null' || token === 'undefined') {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  verifySessionToken(token).then((result) => {
    if (!result.ok) return res.status(401).json({ error: result.error });
    req.user = result.user;
    next();
  }, next);
};
