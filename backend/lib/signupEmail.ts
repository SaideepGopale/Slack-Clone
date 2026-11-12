import { Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from './httpError';
import { invitationState } from './policy';

/**
 * Stage 6A (T.25, finding AUTH-1) — one e-mail address opens at most one
 * account by sign-up, whatever its letter case.
 *
 * "The same address" is decided in ONE place: PostgreSQL's lower(). The
 * invitation-only gate (invited address ↔ typed address), the duplicate-account
 * check and the per-address lock all use it, so any two addresses the gate
 * admits for one invitation have the same lower() value, share one lock and
 * collide in the duplicate check, independent of JavaScript's case mapping
 * (which differs from PostgreSQL's for some letters, e.g. a word-final "Σ").
 *
 * Addresses are still STORED as typed: login matches the stored address
 * exactly (protected, unchanged), so lower-casing on write would lock out
 * anyone who signs up as "Alice@x.com" and logs in the same way.
 */
type Db = Prisma.TransactionClient | PrismaClient;

/** True when PostgreSQL considers the two addresses the same (case-insensitive). */
export const isSameEmail = async (db: Db, a: string, b: string) => {
  const [row] = await db.$queryRaw<{ same: boolean }[]>`SELECT lower(${a}::text) = lower(${b}::text) AS same`;
  return row?.same === true;
};

/**
 * Serialises account creation for one address (every letter case) until the
 * surrounding transaction ends, so the duplicate check below cannot race with
 * another sign-up for the same address. Same pattern as channelNames.ts.
 */
export const lockSignupEmail = (tx: Prisma.TransactionClient, email: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('signup-email:' || lower(${email}::text)))`;

/** An existing account with this address in any letter case, or with exactly this username. */
export const hasSignupConflict = async (db: Db, email: string, username: string) => {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User" WHERE lower(email) = lower(${email}::text) OR username = ${username} LIMIT 1`;
  return rows.length > 0;
};

/**
 * Stage 6C (T.27, R1) — inside the account-creation transaction, after
 * lockSignupEmail: is a pending, unexpired e-mail invitation for this address
 * (PostgreSQL lower(), as in the gate) still there? FOR SHARE holds those rows
 * until the account commits, so a revocation — a single conditional UPDATE —
 * either committed first (seen here: refuse) or waits until this account
 * exists. The invitation itself is not changed: acceptance still consumes it,
 * and a failed sign-up leaves it exactly as it was.
 */
export const hasLiveInvitation = async (tx: Prisma.TransactionClient, email: string) => {
  const rows = await tx.$queryRaw<{ status: string; createdAt: Date }[]>`
    SELECT status, "createdAt" FROM "Invitation"
    WHERE lower(email) = lower(${email}::text) AND status = 'pending'
    FOR SHARE`;
  return rows.some((row) => invitationState(row) === 'pending');
};

/**
 * Stage 6C (T.27, IDN-4) — a unique violation on the account insert means the
 * address or username was taken on another path in the same instant (the
 * checks above cannot see uncommitted rows). Answer like those checks, with
 * the existing 400, instead of a 500 that echoes the database error.
 */
export const rethrowAsDuplicateAccount =
  (message: string) =>
  (err: unknown): never => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new HttpError(400, message);
    throw err;
  };
