import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { directSignupLimiter, loginLimiter, signupRequestLimiter, verifyOtpLimiter } from '../../middleware/rateLimit.middleware';
import {
  forgotPasswordHandler,
  loginHandler,
  meHandler,
  resetPasswordHandler,
  signupHandler,
  signupRequestHandler,
  verifyOtpHandler,
} from './auth.controller';

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
router.post('/forgot-password', forgotPasswordHandler);
router.post('/reset-password', resetPasswordHandler);

export default router;
