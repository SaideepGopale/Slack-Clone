import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAdmin } from '../../middleware/admin.middleware';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { activateAccount } from './activation.service';
import { listTeamLeads, provisionTeamLead, reissueInvitation, revokeInvitation } from './teamLeads.service';
import { listMemberInvitations, myHierarchy, provisionMember, reissueMemberInvitation, revokeMemberInvitation } from './teamMembers.service';

/**
 * Stage 2 (T.20). Two routers, mounted in app.ts:
 *  - /api/team-management — Company Admin only (Team Lead provisioning);
 *  - /api/account-activation — public, rate limited, one-time activation.
 * The existing admin router, admin "Create user", login, JWT and session code
 * are reused unchanged and not modified.
 */

const handle =
  (fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// One-time credentials must never be cached by a browser or proxy.
const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

// requireAdmin (unchanged) re-checks User.role in the database on every
// request. Wrapped so a database error reaches the error handler instead of
// leaving the request hanging (A7) — for these new routes only.
const companyAdminOnly = (req: Request, res: Response, next: NextFunction) => {
  requireAdmin(req as AuthenticatedRequest, res, next).catch(next);
};

const writeLimiter = userRateLimit(30, 60_000, 'Too many Team Lead changes. Please slow down.');

export const teamManagementRoutes = Router();
teamManagementRoutes.use(...requireSessionUser, companyAdminOnly);

teamManagementRoutes.get('/team-leads', handle(async (_req, res) => {
  res.json({ teamLeads: await listTeamLeads() });
}));
teamManagementRoutes.post('/team-leads', writeLimiter, handle(async (req, res) => {
  noStore(res);
  res.status(201).json(await provisionTeamLead(req.user!.id, req.body));
}));
teamManagementRoutes.post('/team-leads/:userId/reissue', writeLimiter, handle(async (req, res) => {
  noStore(res);
  res.status(201).json(await reissueInvitation(req.user!.id, req.params.userId));
}));
teamManagementRoutes.post('/invitations/:invitationId/revoke', writeLimiter, handle(async (req, res) => {
  res.json(await revokeInvitation(req.user!.id, req.params.invitationId));
}));

// Per client address: 10 attempts per 15 minutes (on top of the per-invitation
// lock after 5 wrong temporary passwords). Skipped under NODE_ENV=test, like
// every other limiter in this app.
const activationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many activation attempts. Please wait a few minutes and try again.' },
});

export const accountActivationRoutes = Router();
accountActivationRoutes.post('/', activationLimiter, handle(async (req, res) => {
  noStore(res);
  res.json(await activateAccount(req.body));
}));

// ---- Stage 3 (T.22): Team Lead → Member provisioning, and hierarchy hints ----
// Mounted at /api. Every route is session-authenticated; the service decides
// (active Team Lead + manages that workspace) before reading any input.
export const teamMemberRoutes = Router();
const memberWriteLimiter = userRateLimit(30, 60_000, 'Too many member invitation changes. Please slow down.');

teamMemberRoutes.get('/me/hierarchy', ...requireSessionUser, handle(async (req, res) => {
  res.json(await myHierarchy(req.user!.id));
}));
teamMemberRoutes.get('/workspaces/:workspaceId/member-invitations', ...requireSessionUser, handle(async (req, res) => {
  res.json(await listMemberInvitations(req.user!.id, req.params.workspaceId));
}));
teamMemberRoutes.post('/workspaces/:workspaceId/member-invitations', ...requireSessionUser, memberWriteLimiter, handle(async (req, res) => {
  noStore(res);
  const result = await provisionMember(req.user!.id, req.params.workspaceId, req.body);
  res.status(result.kind === 'created' ? 201 : 409).json(result.body);
}));
teamMemberRoutes.post('/workspaces/:workspaceId/member-invitations/:invitationId/revoke', ...requireSessionUser, memberWriteLimiter, handle(async (req, res) => {
  res.json(await revokeMemberInvitation(req.user!.id, req.params.workspaceId, req.params.invitationId));
}));
teamMemberRoutes.post('/workspaces/:workspaceId/member-invitations/:invitationId/reissue', ...requireSessionUser, memberWriteLimiter, handle(async (req, res) => {
  noStore(res);
  res.status(201).json(await reissueMemberInvitation(req.user!.id, req.params.workspaceId, req.params.invitationId));
}));
