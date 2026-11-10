import { NextFunction, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { getLinkPreview } from './preview.service';
import { BlockedUrlError } from './safeFetch';

const router = Router();

// Keyed on the authenticated user rather than the IP, so it works correctly
// behind Render's proxy without changing the app-wide `trust proxy` setting.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthenticatedRequest).user?.id ?? 'anonymous',
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many preview requests. Please slow down.' },
});

// POST /api/preview — previously public and unrestricted (audit SEC-04).
router.post('/preview', ...requireSessionUser, previewLimiter, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const url = req.body?.url;
    if (typeof url !== 'string' || !url.trim() || url.length > 2048) {
      return res.status(400).json({ error: 'URL is required' });
    }
    res.json(await getLinkPreview(url.trim()));
  } catch (err) {
    if (err instanceof BlockedUrlError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

export default router;
