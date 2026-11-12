import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { HttpError } from '../../lib/httpError';
import { listSessions, revokeAllSessions, revokeSession } from '../../lib/sessions';
import { logAuditEvent } from '../../lib/auditLog';
import * as authService from './auth.service';

// The only request detail kept with a session: a truncated User-Agent, shown
// in the account's own session list. No IP address is stored.
const sessionMeta = (req: AuthenticatedRequest) => ({ userAgent: req.get('user-agent') ?? null });

export const signupHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { username, email, password } = req.body;
    const result = await authService.signup(username, email, password, sessionMeta(req));
    res.status(201).json(result);
  } catch (err) { next(err); }
};

export const signupRequestHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { username, email, password } = req.body;
    const result = await authService.requestSignupOtp(username, email, password);
    res.status(200).json(result);
  } catch (err) { next(err); }
};

export const verifyOtpHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { email, code } = req.body;
    const result = await authService.verifySignupOtp(email, code, sessionMeta(req));
    res.status(201).json(result);
  } catch (err) { next(err); }
};

export const loginHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    const result = await authService.login(email, password, sessionMeta(req));
    res.json(result);
  } catch (err) { next(err); }
};

export const meHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const user = await authService.getMe(req.user!.id);
    res.json(user);
  } catch (err) { next(err); }
};

export const forgotPasswordHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await authService.forgotPassword(req.body.email);
    res.json(result);
  } catch (err) { next(err); }
};

export const resetPasswordHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id, token, newPassword } = req.body;
    const result = await authService.resetPassword(id, token, newPassword);
    res.json(result);
  } catch (err) { next(err); }
};

// ---------------------------------------------------------------------------
// T.32 (audit H1): server-side session management.

/** POST /api/auth/logout — ends this session (its token stops working at once). */
export const logoutHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.sid) await revokeSession(req.user.sid, req.user.id);
    res.json({ message: 'Signed out.' });
  } catch (err) { next(err); }
};

/** POST /api/auth/logout-all — ends every session of the account, this one included. */
export const logoutAllHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const ended = await revokeAllSessions(req.user!.id);
    await logAuditEvent(req.user!.id, 'REVOKE_SESSIONS', 'USER', req.user!.id, `Signed out of all sessions (${ended})`);
    res.json({ message: 'Signed out everywhere.', endedSessions: ended });
  } catch (err) { next(err); }
};

/** GET /api/auth/sessions — the caller's live sessions (no token material). */
export const listSessionsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await listSessions(req.user!.id, req.user!.sid));
  } catch (err) { next(err); }
};

/** DELETE /api/auth/sessions/:sessionId — ends one of the caller's own sessions. */
export const revokeSessionHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const count = await revokeSession(req.params.sessionId, req.user!.id);
    if (count === 0) throw new HttpError(404, 'Session not found.');
    res.json({ message: 'Session ended.' });
  } catch (err) { next(err); }
};

/** POST /api/auth/change-password — { currentPassword, newPassword }. */
export const changePasswordHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    res.json(await authService.changePassword(req.user!.id, req.user!.sid, currentPassword, newPassword));
  } catch (err) { next(err); }
};
