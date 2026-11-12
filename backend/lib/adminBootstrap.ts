import bcrypt from 'bcryptjs';
import { HttpError } from './httpError';
import { isValidEmail } from './email';
import { findLoginOrUsernameClash } from './identity';
import { strongPasswordProblem } from './passwordPolicy';
import { prisma } from './prisma';
import { ensureSharedWorkspaceMembership } from './sharedWorkspace';

/**
 * First Company Admin bootstrap (T.32, audit H6).
 *
 * A fresh database has no administrator, sign-up is invitation-only, and the
 * development seeds refuse production — so nobody could administer a new
 * deployment. This creates exactly one platform ADMIN account, once:
 *
 * - CLI only (scripts/bootstrap-admin.ts): there is no HTTP endpoint for it.
 * - Requires the explicit confirmation phrase below.
 * - No default credentials: e-mail, username and password are supplied by
 *   the operator; the password must pass the strong policy and is never
 *   printed or logged.
 * - Refuses if any ADMIN account already exists (any status), so it cannot
 *   be repeated or used to add a second admin; checked under a transaction-
 *   scoped advisory lock so two concurrent runs cannot both succeed.
 * - Writes a BOOTSTRAP_ADMIN audit entry in the same transaction.
 * - Never deletes or modifies existing data (other than adding the account
 *   to the shared SmartConnect Collab workspace afterwards).
 */
export const BOOTSTRAP_CONFIRM_PHRASE = 'CREATE_FIRST_COMPANY_ADMIN';
const BOOTSTRAP_LOCK_KEY = 74_210_032; // arbitrary, unique to this operation

export interface BootstrapInput {
  confirm: unknown;
  email: unknown;
  username: unknown;
  password: unknown;
}

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

export const bootstrapFirstAdmin = async (input: BootstrapInput) => {
  if (input.confirm !== BOOTSTRAP_CONFIRM_PHRASE) {
    throw new HttpError(400, `Refusing: set BOOTSTRAP_CONFIRM=${BOOTSTRAP_CONFIRM_PHRASE} to confirm this one-time operation.`);
  }
  if (typeof input.email !== 'string' || !isValidEmail(input.email.trim())) {
    throw new HttpError(400, 'Refusing: BOOTSTRAP_ADMIN_EMAIL must be a valid e-mail address.');
  }
  if (typeof input.username !== 'string' || !USERNAME_PATTERN.test(input.username.trim())) {
    throw new HttpError(400, 'Refusing: BOOTSTRAP_ADMIN_USERNAME must be 3–32 letters, digits, ".", "_" or "-".');
  }
  const problem = strongPasswordProblem(input.password);
  if (problem) throw new HttpError(400, `Refusing: BOOTSTRAP_ADMIN_PASSWORD — ${problem}`);

  const email = input.email.trim();
  const username = input.username.trim();
  const passwordHash = await bcrypt.hash(input.password as string, 12);

  const admin = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY}::bigint)`;
    const existingAdmins = await tx.user.count({ where: { role: 'ADMIN' } });
    if (existingAdmins > 0) {
      throw new HttpError(409, 'Refusing: an administrator account already exists. Bootstrap is a one-time operation.');
    }
    if (await findLoginOrUsernameClash(tx, email, username)) {
      throw new HttpError(409, 'Refusing: an account with this e-mail or username already exists.');
    }
    const created = await tx.user.create({
      data: { email, username, password: passwordHash, role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true, username: true, email: true },
    });
    await tx.auditLog.create({
      data: {
        actorId: created.id,
        action: 'BOOTSTRAP_ADMIN',
        targetType: 'USER',
        targetId: created.id,
        details: `First Company Admin "${created.username}" created with the one-time bootstrap command`,
      },
    });
    return created;
  });

  // Same access every active account gets (best effort, never fatal).
  await ensureSharedWorkspaceMembership(admin.id).catch(() => null);
  return admin;
};
