import { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { isValidEmail } from '../lib/email';
import { canWorkspace, invitationState, loadWorkspaceActor, normalizeEmail } from '../lib/policy';
import { prisma } from '../lib/prisma';
import { isSameEmail } from '../lib/signupEmail';

/**
 * Stage 2 finalization (T.21) — public sign-up is invitation-only.
 *
 * Mounted in app.ts IN FRONT OF the unchanged (protected) auth router, for
 * POST /api/auth/signup, /api/auth/signup-request and /api/auth/verify-otp.
 * It never creates anything and never touches login, JWT or sessions: it
 * either lets the request continue to the original handler or refuses it.
 *
 *  - A request whose e-mail is a real address (the same isValidEmail check
 *    every sign-up handler applies) must carry `inviteToken`: a pending,
 *    unexpired e-mail invitation for exactly that address (case-insensitive),
 *    whose inviter may still invite to that workspace. Otherwise: 403, with
 *    one identical answer whatever was wrong (no invitation oracle).
 *  - Anything else is passed through untouched, so the original handler
 *    rejects it exactly as before (FA-SEC-02 validation, required fields).
 *    Such a request can never create an account: every handler refuses an
 *    address that isValidEmail refuses, and verify-otp only completes a
 *    pending row that signup-request (gated) created.
 *
 * One invitation opens at most one account: the sign-up handlers refuse an
 * address that already has an account in ANY letter case, re-checked under a
 * per-address lock (Stage 6A, AUTH-1 — User.email's unique index alone is
 * case-sensitive). Accepting the invitation afterwards (unchanged invitation
 * flow) marks it used, which also closes sign-up for it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INVITE_ONLY_MESSAGE = 'Sign-up is by invitation only. Open the invitation link you received to create your account.';

const refuse = (res: Response) => res.status(403).json({ error: INVITE_ONLY_MESSAGE });

const invitationAllows = async (token: unknown, email: string) => {
  if (typeof token !== 'string' || !UUID.test(token)) return false;
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    select: { email: true, status: true, createdAt: true, inviterId: true, workspaceId: true },
  });
  if (!invitation || invitationState(invitation) !== 'pending') return false;
  if (normalizeEmail(invitation.email) !== normalizeEmail(email)) return false;
  // Stage 6A (AUTH-1): also the same address for PostgreSQL — the comparison
  // the sign-up handlers' duplicate check and lock use (lib/signupEmail.ts).
  if (!(await isSameEmail(prisma, invitation.email, email))) return false;
  try {
    // The inviter must still be allowed to invite (same rule as acceptance).
    return canWorkspace(await loadWorkspaceActor(invitation.inviterId, invitation.workspaceId), 'workspace.manageInvitations');
  } catch {
    return false;
  }
};

export const requireSignupInvitation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email: unknown = req.body?.email;
    if (!isValidEmail(email)) return next(); // the original handler rejects it, unchanged
    if (!(await invitationAllows(req.body?.inviteToken, email as string))) return refuse(res);
    return next();
  } catch (err) {
    return next(err);
  }
};

// Per client address, in front of the gate (the auth router's own limiters
// only see requests the gate lets through). Skipped under NODE_ENV=test, like
// every limiter in this app.
export const signupGateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many sign-up attempts. Please try again later.' },
});

export const INVITE_ONLY_SIGNUP_PATHS = ['/api/auth/signup', '/api/auth/signup-request', '/api/auth/verify-otp'];
