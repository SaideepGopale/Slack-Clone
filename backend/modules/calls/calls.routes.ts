import { Response, Router } from 'express';
import { iceConfigFor } from '../../lib/iceServers';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';

const router = Router();

/**
 * GET /api/calls/ice-servers — the STUN/TURN servers this caller should use
 * (T.32, audit H4). Signed-in users only (TURN credentials are per user and
 * short-lived when CALL_TURN_SECRET is set); never cached by the browser.
 */
router.get('/ice-servers', ...requireSessionUser, userRateLimit(60, 60_000), (req: AuthenticatedRequest, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(iceConfigFor(req.user!.id));
});

export default router;
