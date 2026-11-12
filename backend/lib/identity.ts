import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Stage 6C (T.27, IDN-3) — exact, case-insensitive identity lookups.
 *
 * Prisma's `equals` + `mode: 'insensitive'` compiles to `"column" ILIKE $1`
 * without escaping, so "_" and "%" in an address or username acted as
 * wildcards and "\" as an escape character. Look-alike addresses matched other
 * people's accounts (Team Lead provisioning then returned their details), and
 * some genuine letter-case variants were missed.
 *
 * These helpers compare with PostgreSQL `lower(a) = lower(b)`: an exact
 * comparison in which no character is special. It is the same definition the
 * sign-up checks and lock (lib/signupEmail.ts) and the case-insensitive unique
 * index "User_email_lower_key" use. Stored values are never changed, and login
 * keeps its exact match.
 */
type Db = Prisma.TransactionClient | PrismaClient;

/** Ids of the accounts whose login address equals `email` in any letter case (oldest first; normally none or one). */
export const userIdsByEmail = async (db: Db, email: string) =>
  (await db.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE lower(email) = lower(${email}::text) ORDER BY "createdAt", id`).map(
    (row) => row.id
  );

/** The account whose login address equals `email` in any letter case, or null. */
export const findUserIdByEmail = async (db: Db, email: string): Promise<string | null> => (await userIdsByEmail(db, email))[0] ?? null;

/** The account whose username equals `username` in any letter case, or null. */
export const findUserIdByUsername = async (db: Db, username: string): Promise<string | null> => {
  const [row] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User" WHERE lower(username) = lower(${username}::text) ORDER BY "createdAt", id LIMIT 1`;
  return row?.id ?? null;
};

/** An account holding this login address or this username, each in any letter case. */
export const findLoginOrUsernameClash = async (db: Db, loginId: string, username: string): Promise<{ username: string } | null> => {
  const [row] = await db.$queryRaw<{ username: string }[]>`
    SELECT username FROM "User" WHERE lower(email) = lower(${loginId}::text) OR lower(username) = lower(${username}::text) LIMIT 1`;
  return row ?? null;
};
