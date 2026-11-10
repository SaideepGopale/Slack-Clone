import rateLimit from 'express-rate-limit';
import { AuthenticatedRequest } from './auth.middleware';

/**
 * Per-user rate limiter for authenticated collaboration endpoints. Keyed on
 * the user id (always present behind requireSessionUser), so it works
 * correctly behind Render's proxy without touching the app-wide
 * `trust proxy` setting (which would also change the frozen login limiter).
 * Skipped when NODE_ENV=test, matching the existing limiters.
 */
export const userRateLimit = (limit: number, windowMs = 60_000, message = 'Too many requests. Please slow down.') =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as AuthenticatedRequest).user?.id ?? 'anonymous',
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: message },
  });
