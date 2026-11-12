/**
 * T.33 load-test seed — ISOLATED LOCAL DATABASES ONLY.
 *
 * Creates a realistic organisation for k6 (loadtest/chat.k6.js): workspaces
 * of 100 people each, channels of ~25 members, message history, a project
 * with tasks per workspace, and one login session per user. Writes the
 * session tokens (valid only for this throwaway database and the JWT_SECRET
 * given) to the output file.
 *
 *   DATABASE_URL=postgresql://user@localhost:PORT/ovn_load JWT_SECRET=... \
 *     npx tsx loadtest/seed.ts <users> <out.json>
 *
 * Refuses to run against anything that is not localhost or whose database
 * name does not contain "load" — it must never touch a real database.
 */
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { prisma } from '../lib/prisma';
import { issueSession } from '../lib/sessions';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('load')) {
  console.error('Refusing to seed: DATABASE_URL must be a localhost database whose name contains "load".');
  process.exit(1);
}

const USERS = Number(process.argv[2] ?? 500);
const OUT = process.argv[3];
if (!OUT || !Number.isInteger(USERS) || USERS < 10) {
  console.error('usage: tsx loadtest/seed.ts <users> <out.json>');
  process.exit(1);
}
const PER_WORKSPACE = 100;
const CHANNELS_PER_WORKSPACE = 8;
const HISTORY_PER_CHANNEL = 200;
const TASKS_PER_PROJECT = 150;

const main = async () => {
  const run = randomUUID().slice(0, 6);
  // bcrypt is skipped on purpose: nobody logs in with a password here.
  const users = [];
  for (let i = 0; i < USERS; i++) {
    users.push(
      await prisma.user.create({
        data: { email: `load-${run}-${i}@example.test`, username: `load_${run}_${i}`, password: '!disabled-load-test-account', role: 'USER' },
        select: { id: true, username: true, role: true },
      })
    );
  }

  const out: { token: string; userId: string; workspaceId: string; channelIds: string[]; projectId: string; instance: number }[] = [];
  for (let w = 0; w * PER_WORKSPACE < USERS; w++) {
    const members = users.slice(w * PER_WORKSPACE, (w + 1) * PER_WORKSPACE);
    const owner = members[0];
    const workspace = await prisma.workspace.create({
      data: { name: `Load ${run} ${w}`, slug: `load-${run}-${w}`, ownerId: owner.id },
      select: { id: true },
    });
    await prisma.workspaceMember.createMany({ data: members.map((m, i) => ({ workspaceId: workspace.id, userId: m.id, role: 'MEMBER' as const })) }); // the owner is Workspace.ownerId

    const general = await prisma.channel.create({ data: { name: 'general', workspaceId: workspace.id, createdBy: owner.id }, select: { id: true } });
    await prisma.channelMember.createMany({ data: members.map((m) => ({ channelId: general.id, userId: m.id, role: 'member' })) });
    const channels: { id: string; members: string[] }[] = [];
    for (let c = 0; c < CHANNELS_PER_WORKSPACE; c++) {
      // ~25 members each, overlapping (everyone is in 2 team channels).
      const channelMembers = members.filter((_, i) => i % CHANNELS_PER_WORKSPACE === c || (i + 3) % CHANNELS_PER_WORKSPACE === c);
      const channel = await prisma.channel.create({ data: { name: `team-${c}`, workspaceId: workspace.id, createdBy: owner.id }, select: { id: true } });
      await prisma.channelMember.createMany({ data: channelMembers.map((m) => ({ channelId: channel.id, userId: m.id, role: 'member' })) });
      channels.push({ id: channel.id, members: channelMembers.map((m) => m.id) });
      const now = Date.now();
      await prisma.message.createMany({
        data: Array.from({ length: HISTORY_PER_CHANNEL }, (_, k) => ({
          channelId: channel.id,
          workspaceId: workspace.id,
          senderId: channelMembers[k % channelMembers.length].id,
          content: `<p>History message ${k} in team-${c}</p>`,
          createdAt: new Date(now - (HISTORY_PER_CHANNEL - k) * 60_000),
        })),
      });
    }

    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: `Load Project ${w}`, key: 'LOAD', createdById: owner.id, taskSequence: TASKS_PER_PROJECT, members: { create: members.map((m, i) => ({ userId: m.id, role: i === 0 ? 'OWNER' : 'MEMBER' })) } },
      select: { id: true },
    });
    const statuses = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const;
    await prisma.task.createMany({
      data: Array.from({ length: TASKS_PER_PROJECT }, (_, k) => ({
        projectId: project.id,
        workspaceId: workspace.id,
        number: k + 1,
        title: `Seeded task ${k + 1}`,
        status: statuses[k % statuses.length],
        priority: (['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const)[k % 4],
        creatorId: owner.id,
        assigneeId: members[k % members.length].id,
        position: (k + 1) * 1024,
        dueDate: new Date(Date.now() + ((k % 20) - 5) * 86_400_000),
      })),
    });

    for (const [i, m] of members.entries()) {
      out.push({
        token: await issueSession(m, { userAgent: 'k6-load-test' }),
        userId: m.id,
        workspaceId: workspace.id,
        channelIds: [general.id, ...channels.filter((c) => c.members.includes(m.id)).map((c) => c.id)],
        projectId: project.id,
        instance: i % 2,
      });
    }
    console.log(`workspace ${w + 1}: ${members.length} users, ${CHANNELS_PER_WORKSPACE + 1} channels, ${TASKS_PER_PROJECT} tasks`);
  }
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`seeded ${users.length} users; sessions written to ${OUT}`);
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
