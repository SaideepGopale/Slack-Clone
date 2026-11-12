/**
 * Makes files uploaded before T.32 private (see lib/legacyFiles.ts).
 *
 *   npx tsx scripts/privatize-legacy-files.ts                 # dry run: reports only
 *   PRIVATIZE_CONFIRM=MAKE_LEGACY_FILES_PRIVATE \
 *     npx tsx scripts/privatize-legacy-files.ts --apply       # converts
 *
 * Run against the production database only after a backup. It needs the
 * production Cloudinary credentials (renames happen in Cloudinary). Old public
 * links of converted files stop working; the app shows them through signed
 * links instead. Nothing is deleted.
 */
import { privatizeLegacyFiles } from '../lib/legacyFiles';
import { prisma } from '../lib/prisma';

const apply = process.argv.includes('--apply');
if (apply && process.env.PRIVATIZE_CONFIRM !== 'MAKE_LEGACY_FILES_PRIVATE') {
  console.error('Refusing to apply: set PRIVATIZE_CONFIRM=MAKE_LEGACY_FILES_PRIVATE (and take a database backup first).');
  process.exit(1);
}

privatizeLegacyFiles({ apply })
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (report.dryRun) console.log('Dry run only — nothing changed. Re-run with --apply and PRIVATIZE_CONFIRM to convert.');
    if (report.failed.length) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
