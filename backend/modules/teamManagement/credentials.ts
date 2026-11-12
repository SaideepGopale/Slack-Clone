import { createHash, randomBytes, randomInt } from 'crypto';

/**
 * Stage 2 (T.20) — one-time credentials for provisioned accounts.
 * Everything here uses Node's CSPRNG. Plaintext values exist only in memory
 * and in the single response that shows them to the Company Admin; the
 * database keeps a SHA-256 of the link token and a bcrypt of the temporary
 * password (see teamLeads.service.ts).
 */

// Unambiguous characters (no 0/O, 1/l/I) so a temporary password can be read
// aloud or retyped. 57 symbols × 20 characters ≈ 116 bits of entropy.
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_GROUPS = 4;
const TEMP_GROUP_LENGTH = 5;

/** e.g. "Kp7Qm-3xTzR-hW9aB-c4NvE" — never derived from the e-mail address. */
export const generateTemporaryPassword = () =>
  Array.from({ length: TEMP_GROUPS }, () =>
    Array.from({ length: TEMP_GROUP_LENGTH }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('')
  ).join('-');

/** 256-bit link token, base64url (43 characters). */
export const generateActivationToken = () => randomBytes(32).toString('base64url');

export const ACTIVATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What the database stores (and looks up by) instead of the token itself. */
export const hashActivationToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Unknowable placeholder password for an account that has not been activated yet. */
export const generateUnusablePassword = () => randomBytes(32).toString('hex');

/** Fingerprint of an account's stored password hash (detects a change made some other way). */
export const credentialFingerprint = (passwordHash: string) => createHash('sha256').update(passwordHash).digest('hex');

/** Invitation lifetime: TEAM_LEAD_INVITATION_TTL_HOURS (1–720), default 72 hours. */
export const invitationTtlMs = () => {
  const hours = Number(process.env.TEAM_LEAD_INVITATION_TTL_HOURS);
  const valid = Number.isFinite(hours) && hours >= 1 && hours <= 720 ? hours : 72;
  return valid * 60 * 60 * 1000;
};

export const BCRYPT_COST = 12; // the application's existing cost (auth.service, admin provisioning)
export const MAX_ACTIVATION_ATTEMPTS = 5;
export const NEW_PASSWORD_MIN = 10;
export const NEW_PASSWORD_MAX = 128;
