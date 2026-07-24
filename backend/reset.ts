/**
 * Full database purge + re-seed for a fresh QA testing phase.
 *
 * Task 1 — deletes every row from every data table, child-to-parent, inside
 * one transaction (all-or-nothing: if any single deleteMany fails, nothing
 * is wiped). AuditLog is included even though it wasn't in the original
 * child-to-parent list requested — its `actorId` is a RESTRICT (not Cascade)
 * foreign key to User by design (see schema.prisma: an admin's history must
 * survive their own account being deleted), so leaving it in place would
 * make the final `user.deleteMany()` below throw a foreign-key violation for
 * any user who ever triggered an audited action. OTPVerification is cleared
 * too (no FK to anything, but "completely wipe" should mean every table).
 *
 * Task 2 — immediately after, creates the one thing the app cannot function
 * without: a System Admin user, the Default/Global Workspace (isDefault:
 * true), and its "General" channel — named with that exact capitalization
 * because auth.service.ts's self-serve signup and invitations.service.ts's
 * accept flow both look it up with an exact-case `name: 'General'` match.
 * Creating it lowercase would silently break auto-join for every signup
 * after running this script.
 *
 * Usage:  npx tsx reset.ts
 */
import bcrypt from 'bcryptjs';
import { prisma } from './lib/prisma';
import { DEFAULT_WORKSPACE_SLUG } from './modules/workspaces/workspaces.service';

const SYSTEM_ADMIN_EMAIL = 'system.admin@slick.internal';
const SYSTEM_ADMIN_USERNAME = 'System Admin';
const SYSTEM_ADMIN_PASSWORD = 'SystemAdmin123!';
const DEFAULT_WORKSPACE_NAME = 'Default Workspace';

async function purge() {
  console.log('--- TASK 1: PURGING DATABASE ---');

  // Array form (not the interactive callback form) — these deletes don't
  // depend on each other's results, just on running in this specific order
  // inside one real DB transaction so a failure partway through rolls
  // everything back instead of leaving a half-wiped database.
  const [
    reactions,
    notifications,
    messages,
    channelMembers,
    channels,
    workspaceMembers,
    invitations,
    workspaces,
    auditLogs,
    otpVerifications,
    users,
  ] = await prisma.$transaction([
    prisma.reaction.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.message.deleteMany(),
    prisma.channelMember.deleteMany(),
    prisma.channel.deleteMany(),
    prisma.workspaceMember.deleteMany(),
    prisma.invitation.deleteMany(),
    prisma.workspace.deleteMany(),
    // Not in the originally requested list — required so the User delete
    // below doesn't hit AuditLog's RESTRICT constraint. See file header.
    prisma.auditLog.deleteMany(),
    prisma.oTPVerification.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  console.log(`  -> Reactions:         ${reactions.count} deleted`);
  console.log(`  -> Notifications:     ${notifications.count} deleted`);
  console.log(`  -> Messages:          ${messages.count} deleted`);
  console.log(`  -> ChannelMembers:    ${channelMembers.count} deleted`);
  console.log(`  -> Channels:          ${channels.count} deleted`);
  console.log(`  -> WorkspaceMembers:  ${workspaceMembers.count} deleted`);
  console.log(`  -> Invitations:       ${invitations.count} deleted`);
  console.log(`  -> Workspaces:        ${workspaces.count} deleted`);
  console.log(`  -> AuditLogs:         ${auditLogs.count} deleted`);
  console.log(`  -> OTPVerifications:  ${otpVerifications.count} deleted`);
  console.log(`  -> Users:             ${users.count} deleted`);
  console.log('--- PURGE COMPLETE ---\n');
}

async function seedFoundation() {
  console.log('--- TASK 2: CREATING GLOBAL FOUNDATION ---');

  const hashedPassword = await bcrypt.hash(SYSTEM_ADMIN_PASSWORD, 12);

  // Interactive callback form here (unlike the purge above) — each step
  // needs the previous step's generated id, so these genuinely have to run
  // in sequence, not just "in this order for readability."
  const { admin, workspace, generalChannel } = await prisma.$transaction(async (tx) => {
    console.log(`Creating system admin user "${SYSTEM_ADMIN_USERNAME}" (${SYSTEM_ADMIN_EMAIL})...`);
    const admin = await tx.user.create({
      data: {
        username: SYSTEM_ADMIN_USERNAME,
        email: SYSTEM_ADMIN_EMAIL,
        password: hashedPassword,
        role: 'ADMIN',
      },
    });
    console.log(`  -> User id: ${admin.id}`);

    console.log(`Creating "${DEFAULT_WORKSPACE_NAME}" (isDefault: true)...`);
    const workspace = await tx.workspace.create({
      data: {
        name: DEFAULT_WORKSPACE_NAME,
        slug: DEFAULT_WORKSPACE_SLUG,
        ownerId: admin.id,
        isDefault: true,
      },
    });
    console.log(`  -> Workspace id: ${workspace.id}`);

    console.log('Adding system admin as a WorkspaceMember (ADMIN)...');
    await tx.workspaceMember.create({
      data: { userId: admin.id, workspaceId: workspace.id, role: 'ADMIN' },
    });

    console.log('Creating the "General" channel...');
    const generalChannel = await tx.channel.create({
      data: {
        name: 'General',
        isDM: false,
        createdBy: admin.id,
        workspaceId: workspace.id,
      },
    });
    console.log(`  -> Channel id: ${generalChannel.id}`);

    console.log('Adding system admin as a ChannelMember (admin)...');
    await tx.channelMember.create({
      data: { userId: admin.id, channelId: generalChannel.id, role: 'admin' },
    });

    return { admin, workspace, generalChannel };
  });

  console.log('--- FOUNDATION CREATED ---');
  console.log(`  Login:        ${admin.email} / ${SYSTEM_ADMIN_PASSWORD}`);
  console.log(`  Workspace:    ${workspace.name} (${workspace.id})`);
  console.log(`  Channel:      #${generalChannel.name} (${generalChannel.id})\n`);
}

async function main() {
  await purge();
  await seedFoundation();
  console.log('Database reset complete — ready for QA.');
}

main()
  .catch((err) => {
    console.error('Reset script failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
