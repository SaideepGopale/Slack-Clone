import { NextFunction, Request, Response, Router } from 'express';
import { requireAdmin } from '../../middleware/admin.middleware';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { companySummary, companyWorkspaceDetail, listCompanyTeamLeads, listCompanyWorkspaces } from './companyOverview.service';

/**
 * Stage 4 (T.23) — /api/company-overview: read-only, Company Admin only.
 * Uses the existing session check and platform-admin check (requireAdmin,
 * unchanged — DB role re-check on every request). No write routes.
 */
const handle =
  (fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// requireAdmin is async without its own error handling (A7); wrapped so a
// database error reaches the error handler for these routes.
const companyAdminOnly = (req: Request, res: Response, next: NextFunction) => {
  requireAdmin(req as AuthenticatedRequest, res, next).catch(next);
};

export const companyOverviewRoutes = Router();
companyOverviewRoutes.use(...requireSessionUser, companyAdminOnly, userRateLimit(120, 60_000, 'Too many overview requests. Please slow down.'));

companyOverviewRoutes.get('/summary', handle(async (_req, res) => {
  res.json(await companySummary());
}));
companyOverviewRoutes.get('/workspaces', handle(async (req, res) => {
  res.json(await listCompanyWorkspaces(req.query as Record<string, unknown>));
}));
companyOverviewRoutes.get('/workspaces/:workspaceId', handle(async (req, res) => {
  res.json(await companyWorkspaceDetail(req.params.workspaceId));
}));
companyOverviewRoutes.get('/team-leads', handle(async (req, res) => {
  res.json(await listCompanyTeamLeads(req.query as Record<string, unknown>));
}));
