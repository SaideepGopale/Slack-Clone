import crypto from 'crypto';
import { JWT_SECRET } from '../config/env';

const OTP_LENGTH = 6;
const OTP_MIN = 10 ** (OTP_LENGTH - 1); // 100000
const OTP_MAX = 10 ** OTP_LENGTH; // 1000000 (exclusive)
export const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_OTP_ATTEMPTS = 3;

/**
 * A 6-digit code drawn from `crypto.randomInt`, which is CSPRNG-backed —
 * unlike `Math.random()`, its output can't be predicted even if an attacker
 * observes many prior outputs. Zero-padded so e.g. 42 renders as "000042",
 * not "42".
 */
export const generateOtp = (): string => {
  const value = crypto.randomInt(OTP_MIN, OTP_MAX);
  return String(value).padStart(OTP_LENGTH, '0');
};

// HMAC (not a bare hash) with a server-side secret: even if the
// OTPVerification table leaks, a 6-digit code's tiny keyspace makes a plain
// SHA-256 rainbow table trivial to build — keying it with a secret the
// attacker doesn't have makes that precomputation useless. Namespaced with
// ':otp' so this can never collide with JWT_SECRET's other use.
const otpKey = () => `${JWT_SECRET}:otp`;

export const hashOtp = (code: string): string =>
  crypto.createHmac('sha256', otpKey()).update(code).digest('hex');

/**
 * Timing-safe comparison — a naive `===` on the hash strings would leak how
 * many leading bytes matched via response-time differences, letting an
 * attacker recover the hash (and from there, brute-force the 6-digit code
 * offline) byte-by-byte instead of code-by-code.
 */
export const verifyOtp = (submittedCode: string, storedHash: string): boolean => {
  const submittedHash = Buffer.from(hashOtp(submittedCode));
  const stored = Buffer.from(storedHash);
  if (submittedHash.length !== stored.length) return false;
  return crypto.timingSafeEqual(submittedHash, stored);
};
