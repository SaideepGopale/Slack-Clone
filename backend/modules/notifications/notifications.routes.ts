import { NextFunction, Response, Router } from 'express';
import { listNotifications, markNotificationsRead, searchWorkspace } from '../../lib/notifications';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';

// P2 Phase I: the Activity feed (mentions + thread replies) and workspace
// search. Both are workspace-scoped and only ever expose messages from
// conversations the caller currently belongs to (see lib/notifications.ts).
const router = Router();
const readLimiter = userRateLimit(120, 60_000, 'Too many requests. Please slow down.');
const writeLimiter = userRateLimit(60, 60_000, 'Too many requests. Please slow down.');
const searchLimiter = userRateLimit(60, 60_000, 'Too many searches. Please slow down.');

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

// GET /api/workspaces/:workspaceId/notifications
router.get(
  '/workspaces/:workspaceId/notifications',
  ...requireSessionUser,
  readLimiter,
  handle(async (req, res) => res.json(await listNotifications(req.user!.id, req.params.workspaceId)))
);

// POST /api/workspaces/:workspaceId/notifications/read  { ids?: string[] }
router.post(
  '/workspaces/:workspaceId/notifications/read',
  ...requireSessionUser,
  writeLimiter,
  handle(async (req, res) => res.json(await markNotificationsRead(req.user!.id, req.params.workspaceId, req.body?.ids)))
);

// GET /api/workspaces/:workspaceId/search?q=
router.get(
  '/workspaces/:workspaceId/search',
  ...requireSessionUser,
  searchLimiter,
  handle(async (req, res) => res.json(await searchWorkspace(req.user!.id, req.params.workspaceId, req.query.q)))
);

export default router;
