// RETIRED (T.32): this was a plain-JavaScript duplicate of seed.ts and had
// fallen out of date (it created a channel without the now-required
// workspace, so it failed after creating the accounts). The maintained
// development seed is seed.ts:
//
//   SEED_USER_PASSWORD='<12+ chars>' SEED_ADMIN_PASSWORD='<12+ chars>' npx tsx seed.ts
//
// For a production database use `npm run admin:bootstrap` (first Company
// Admin only) — never a development seed.
console.error('seed.mjs is retired. Use: npx tsx seed.ts (development only) or npm run admin:bootstrap (first admin).');
process.exitCode = 1;
