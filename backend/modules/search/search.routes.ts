import { NextFunction, Response, Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { searchEverything } from './search.service';

/** T.33 — GET /api/workspaces/:workspaceId/search/all?q= (command palette). 60 searches/min per user. */
const router = Router();
const limiter = userRateLimit(60, 60_000, 'Too many searches. Please slow down.');

router.get('/workspaces/:workspaceId/search/all', ...requireSessionUser, limiter, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await searchEverything(req.user!.id, req.params.workspaceId, req.query.q));
  } catch (err) {
    next(err);
  }
});

export default router;
