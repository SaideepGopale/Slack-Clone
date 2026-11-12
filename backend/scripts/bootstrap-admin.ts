/**
 * One-time creation of the first Company Admin (T.32, audit H6).
 *
 * Usage (from backend/, against the target database; run it ONCE):
 *
 *   BOOTSTRAP_CONFIRM=CREATE_FIRST_COMPANY_ADMIN \
 *   BOOTSTRAP_ADMIN_EMAIL='owner@your-company.example' \
 *   BOOTSTRAP_ADMIN_USERNAME='owner' \
 *   BOOTSTRAP_ADMIN_PASSWORD='<12+ chars, 3 of lower/upper/digit/symbol>' \
 *   npm run admin:bootstrap
 *
 * Prefer entering the password with `read -s BOOTSTRAP_ADMIN_PASSWORD` and
 * `export`, so it never lands in shell history. On Render, run it once from
 * the service's Shell tab with the same variables, then unset them.
 *
 * It refuses if any administrator already exists, never prints the password,
 * deletes nothing, and records a BOOTSTRAP_ADMIN audit entry. Afterwards sign
 * in through the normal login page.
 */
import { bootstrapFirstAdmin } from '../lib/adminBootstrap';
import { prisma } from '../lib/prisma';

const main = async () => {
  const admin = await bootstrapFirstAdmin({
    confirm: process.env.BOOTSTRAP_CONFIRM,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    username: process.env.BOOTSTRAP_ADMIN_USERNAME,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  console.log(`First Company Admin created: username "${admin.username}" (id ${admin.id}). Sign in with the e-mail and password you supplied.`);
};

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : 'Bootstrap failed.');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
