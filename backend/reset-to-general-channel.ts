/**
 * One-time migration script: collapses the workspace down to a single
 * universal "General" channel.
 *
 * What it does:
 *   1. Deletes every non-DM channel (Devcons, Nexus, etc.) — their messages,
 *      reactions, and memberships cascade-delete automatically via the FK
 *      constraints in schema.prisma.
 *   2. Creates one fresh channel named "General".
 *   3. Adds every existing user as a member of it.
 *
 * What it deliberately does NOT touch: Direct Messages. DMs are Channel rows
 * with isDM=true, and are left completely alone — this is a channel
 * consolidation, not a DM wipe.
 *
 * Safe to re-run: it always deletes non-DM channels first (including any
 * "General" from a previous run) before creating a fresh one, so running it
 * twice just resets again rather than producing duplicates.
 *
 * Usage:  npx tsx reset-to-general-channel.ts
 */
import { prisma } from './lib/prisma';

async function main() {
  console.log('Deleting all non-DM channels (messages/reactions/memberships cascade automatically)...');
  const deleted = await prisma.channel.deleteMany({ where: { isDM: false } });
  console.log(`  -> deleted ${deleted.count} channel(s).`);

  const users = await prisma.user.findMany({
    select: { id: true, username: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (users.length === 0) {
    console.log('No users exist yet — nothing to seed membership for. Exiting without creating "General".');
    return;
  }

  // Prefer an admin as the nominal creator; falls back to the earliest
  // registered user. With only one channel in the whole app, this is mostly
  // cosmetic metadata at this point.
  const creator = users.find((u) => u.role === 'ADMIN') ?? users[0];

  console.log(`Creating "General" (creator: ${creator.username})...`);
  const general = await prisma.channel.create({
    data: { name: 'General', isDM: false, createdBy: creator.id },
  });

  console.log(`Adding all ${users.length} existing user(s) as members...`);
  await prisma.channelMember.createMany({
    data: users.map((u) => ({
      channelId: general.id,
      userId: u.id,
      role: u.id === creator.id ? 'admin' : 'member',
    })),
    skipDuplicates: true,
  });

  console.log(`Done. "General" channel id: ${general.id}, ${users.length} member(s) added.`);
}

main()
  .catch((err) => {
    console.error('Reset script failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
z