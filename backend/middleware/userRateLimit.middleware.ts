import { createLimiter } from './limiter';
import { AuthenticatedRequest } from './auth.middleware';

/**
 * Per-user rate limiter for authenticated collaboration endpoints. Keyed on
 * the user id (always present behind requireSessionUser), so it works
 * correctly behind Render's proxy without touching the app-wide
 * `trust proxy` setting (which would also change the frozen login limiter).
 * Skipped when NODE_ENV=test, matching the existing limiters.
 */
let userLimiterCount = 0;
export const userRateLimit = (limit: number, windowMs = 60_000, message = 'Too many requests. Please slow down.') =>
  // T.33: Redis-backed when REDIS_URL is set (shared across instances). The
  // prefix is the limiter's creation order, which is identical in every
  // instance of the same build, so each limiter keeps its own budget.
  createLimiter(`user${++userLimiterCount}`, {
    windowMs,
    limit,
    keyGenerator: (req) => (req as AuthenticatedRequest).user?.id ?? 'anonymous',
    message: { error: message },
  });
