/**
 * E-mail format check shared by signup, signup-request and invitations
 * (P1-C, finding FA-SEC-02).
 *
 * The pattern is unchanged, so every address accepted before is still
 * accepted, up to the length limit. On its own, though, it backtracks
 * quadratically on input such as "a@" + "."×n + "@": ~0.2 s at 16k
 * characters, ~3.4 s at 64k and ~14 minutes at the 1 MB request-body limit,
 * during which the single event loop serves nobody.
 *
 * Real addresses are at most 254 characters (RFC 5321's 256-octet path limit
 * minus the angle brackets), so anything longer is refused before the pattern
 * runs. That bounds its worst case to well under a millisecond. Non-strings
 * are refused too: the pattern would coerce them to text, and an array's
 * `length` says nothing about the length of that text.
 */
export const MAX_EMAIL_LENGTH = 254;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidEmail = (value: unknown): boolean =>
  typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value);
