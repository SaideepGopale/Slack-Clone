import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { loginLimiter, signupRequestLimiter, verifyOtpLimiter } from '../../middleware/rateLimit.middleware';
import {
  forgotPasswordHandler,
  loginHandler,
  meHandler,
  resetPasswordHandler,
  signupRequestHandler,
  verifyOtpHandler,
} from './auth.controller';

const router = Router();

// The old single-step POST /register is gone — an unverified-email sign-up
// path can't coexist with the OTP flow below, or it'd just be a bypass.
router.post('/signup-request', signupRequestLimiter, signupRequestHandler);
router.post('/verify-otp', verifyOtpLimiter, verifyOtpHandler);

router.post('/login', loginLimiter, loginHandler);
router.get('/me', authenticate, meHandler);
router.post('/forgot-password', forgotPasswordHandler);
router.post('/reset-password', resetPasswordHandler);

export default router;
