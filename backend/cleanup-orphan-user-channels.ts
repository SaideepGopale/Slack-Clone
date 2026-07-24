/**
 * One-time safety-net cleanup: deletes any PUBLIC channel (isDM: false)
 * whose name exactly matches a real user's username (case-insensitive),
 * excluding "general".
 *
 * Context: investigating the "# Samarth Karale" bug report found no live
 * code path that actually persists a username into Channel.name — DM
 * channels (dm.service.ts's findOrCreateDM) always store `name: null`; the
 * username only ever appeared as a *display-time* override (withDisplayName
 * in channels.service.ts), and the listing queries that leaked DMs into the
 * public-channels list have been fixed separately (isDM filters added to
 * listChannelsForUser/listChannelsForWorkspace). So this script should find
 * nothing in a healthy database — it exists as a safety net for any stale
 * rows from before those fixes, or from a data path outside this codebase
 * (a manual DB edit, an old migration, etc.).
 *
 * Dry-run by default — logs what it *would* delete without touching
 * anything. Pass --delete to actually perform the deletion.
 *
 * Usage:
 *   npx tsx cleanup-orphan-user-channels.ts            # report only
 *   npx tsx cleanup-orphan-user-channels.ts --delete    # actually delete
 */
import { prisma } from './lib/prisma';

const RESERVED = new Set(['general']);

async function main() {
  const shouldDelete = process.argv.includes('--delete');

  console.log(`Mode: ${shouldDelete ? 'DELETE' : 'DRY RUN (pass --delete to actually remove rows)'}`);

  const users = await prisma.user.findMany({ select: { username: true } });
  const usernamesLower = new Set(users.map((u) => u.username.toLowerCase()));

  const publicChannels = await prisma.channel.findMany({
    where: { isDM: false },
    select: { id: true, name: true, createdAt: true, workspaceId: true },
  });

  const orphans = publicChannels.filter((c) => {
    if (!c.name) return false;
    const lower = c.name.toLowerCase();
    return usernamesLower.has(lower) && !RESERVED.has(lower);
  });

  if (orphans.length === 0) {
    console.log('No orphan user-named channels found. Nothing to do.');
    return;
  }

  console.log(`Found ${orphans.length} orphan channel(s) matching a username:`);
  for (const c of orphans) {
    console.log(`  -> "${c.name}" (id: ${c.id}, workspace: ${c.workspaceId}, created: ${c.createdAt.toISOString()})`);
  }

  if (!shouldDelete) {
    console.log('\nDry run only — no rows deleted. Re-run with --delete to remove these.');
    return;
  }

  const { count } = await prisma.channel.deleteMany({
    where: { id: { in: orphans.map((c) => c.id) } },
  });
  console.log(`\nDeleted ${count} orphan channel(s).`);
}

main()
  .catch((err) => {
    console.error('Cleanup script failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
