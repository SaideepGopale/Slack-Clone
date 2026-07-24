import rateLimit from 'express-rate-limit';

// Originally scoped narrowly to the two OTP sign-up endpoints; loginLimiter
// below closes the most urgent of the other pre-existing gaps (an
// unthrottled /login was open to unlimited-speed password brute-forcing).
// Message-send/reactions still have no rate limiting — a separate, lower-
// priority gap than "anyone can brute-force any account's password."

// Signup-request sends a real email per call — the abuse case is either
// spamming someone else's inbox or burning through email-provider quota.
export const signupRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification codes requested. Please try again later.' },
});

// Verify-otp already has its own per-code attempt cap (MAX_OTP_ATTEMPTS in
// lib/otp.ts), but that resets every time a new code is requested — this
// caps the *rate* of verification attempts across codes too, so someone
// can't cycle through signup-request -> verify-otp in a tight loop to get
// effectively unlimited guesses.
export const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' },
});

// 10 attempts / 15 min / IP — generous enough that a real user mistyping
// their password a few times never gets caught by it, tight enough that
// brute-forcing a password at any real speed is no longer possible. Keyed on
// IP (the default), not email, so this can't be used to lock a specific
// victim's account out by deliberately failing their login repeatedly.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});
