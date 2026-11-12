import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import {
  directSignupLimiter,
  forgotPasswordLimiter,
  loginLimiter,
  resetPasswordLimiter,
  signupRequestLimiter,
  verifyOtpLimiter,
} from '../../middleware/rateLimit.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import {
  changePasswordHandler,
  forgotPasswordHandler,
  listSessionsHandler,
  loginHandler,
  logoutAllHandler,
  logoutHandler,
  meHandler,
  resetPasswordHandler,
  revokeSessionHandler,
  signupHandler,
  signupRequestHandler,
  verifyOtpHandler,
} from './auth.controller';

// Wrong current passwords count too: this bounds guessing from a stolen session.
export const CHANGE_PASSWORD_LIMIT = 10;
const changePasswordLimiter = userRateLimit(CHANGE_PASSWORD_LIMIT, 15 * 60 * 1000, 'Too many password change attempts. Please try again later.');

const router = Router();

// /signup is a direct, unverified-email path — reintroduced deliberately (see
// auth.service.ts's signup) as a stopgap while production email delivery
// isn't reachable. AuthForm.tsx calls this one right now. /signup-request +
// /verify-otp below are left fully working for whenever email delivery is
// fixed and email verification is worth re-enabling — not dead code, just
// not the active path.
router.post('/signup', directSignupLimiter, signupHandler);
router.post('/signup-request', signupRequestLimiter, signupRequestHandler);
router.post('/verify-otp', verifyOtpLimiter, verifyOtpHandler);

router.post('/login', loginLimiter, loginHandler);
router.get('/me', authenticate, meHandler);
router.post('/forgot-password', forgotPasswordLimiter, forgotPasswordHandler);
router.post('/reset-password', resetPasswordLimiter, resetPasswordHandler);

// T.32 (audit H1): server-side sessions — sign out of this device, of all
// devices, list and end individual sessions, and change the password.
router.post('/logout', authenticate, logoutHandler);
router.post('/logout-all', authenticate, logoutAllHandler);
router.get('/sessions', authenticate, listSessionsHandler);
router.delete('/sessions/:sessionId', authenticate, revokeSessionHandler);
router.post('/change-password', authenticate, changePasswordLimiter, changePasswordHandler);

export default router;
