import { Prisma } from '@prisma/client';
import { attachmentPath } from '../../lib/attachments';
import { HttpError } from '../../lib/httpError';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import { canManageWorkspace, loadWorkspaceActor, projectChannelAccessWhere, visibleProjectsWhere } from '../../lib/policy';
import { CLOSED_STATUSES, privateAssignmentFilter, taskSelect, taskView } from '../tasks/tasks.views';

/**
 * T.33 — the command palette's workspace search: channels, people, projects,
 * tasks and files (messages keep their own endpoint, lib/notifications
 * searchWorkspace). Every result set is scoped exactly like the screens that
 * show those things:
 *  - channels: public ones the caller's project access allows, plus their own
 *    (never another person's private channel or DM, even for admins);
 *  - people: active members of the workspace — usernames and display names
 *    only, never e-mail addresses;
 *  - projects/tasks: lib/policy visibleProjectsWhere (private projects only
 *    for their members and managers);
 *  - files: attachments of messages in conversations the caller belongs to,
 *    within their history window.
 */
const MIN = 2;
const MAX = 100;
const PER_TYPE = 8;

export const searchEverything = async (userId: string, workspaceId: string, rawQuery: unknown) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (q.length < MIN || q.length > MAX) throw new HttpError(400, `Search for ${MIN}–${MAX} characters.`);
  const workspace = await loadWorkspaceActor(userId, workspaceId);
  if (workspace.workspaceRole === null) throw new HttpError(404, 'Workspace not found.');
  const contains = { contains: q, mode: 'insensitive' as const };

  const memberships = await prisma.channelMember.findMany({
    where: { userId, channel: { workspaceId, ...projectChannelAccessWhere(userId) } },
    select: { channelId: true, historyFrom: true },
  });
  const full = memberships.filter((m) => !m.historyFrom).map((m) => m.channelId);
  const messageScope: Prisma.MessageWhereInput[] = [
    ...(full.length ? [{ channelId: { in: full } }] : []),
    ...memberships.filter((m) => m.historyFrom).map((m) => ({ channelId: m.channelId, createdAt: { gte: m.historyFrom! } })),
  ];
  const identifier = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,7})$/.exec(q);

  const [channels, people, projects, tasks, files] = await Promise.all([
    prisma.channel.findMany({
      where: {
        workspaceId,
        isDM: false,
        name: contains,
        AND: [projectChannelAccessWhere(userId), { OR: [{ visibility: 'PUBLIC' }, { members: { some: { userId } } }] }],
      },
      select: { id: true, name: true, visibility: true, archivedAt: true, projectId: true, members: { where: { userId }, select: { id: true } } },
      orderBy: { name: 'asc' },
      take: PER_TYPE,
    }),
    prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        workspaces: { some: { workspaceId } },
        OR: [{ username: contains }, { profile: { displayName: contains } }],
      },
      select: { id: true, username: true, profile: { select: { displayName: true, title: true } } },
      orderBy: { username: 'asc' },
      take: PER_TYPE,
    }),
    prisma.project.findMany({
      where: { AND: [visibleProjectsWhere(workspace), { OR: [{ name: contains }, { key: { equals: q.toUpperCase() } }] }] },
      select: { id: true, name: true, key: true, status: true, archivedAt: true, visibility: true },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
      take: PER_TYPE,
    }),
    prisma.task.findMany({
      where: {
        workspaceId,
        AND: [
          // T.38: tasks of visible projects (minus other people's private
          // assignments for non-leads), plus the caller's own private assignments.
          {
            OR: [
              { project: visibleProjectsWhere(workspace), ...(canManageWorkspace(workspace) ? {} : privateAssignmentFilter(userId)) },
              { assigneeOnly: true, assigneeId: userId },
              { assigneeOnly: true, creatorId: userId },
            ],
          },
          { OR: [{ title: contains }, ...(identifier ? [{ number: Number(identifier[2]), project: { OR: [{ key: identifier[1].toUpperCase() }, { name: { startsWith: identifier[1], mode: 'insensitive' as const } }] } }] : [])] },
        ],
      },
      select: taskSelect,
      // Open work first.
      orderBy: [{ completedAt: { sort: 'desc', nulls: 'first' } }, { updatedAt: 'desc' }],
      take: PER_TYPE,
    }),
    messageScope.length
      ? prisma.attachment.findMany({
          where: { originalName: contains, message: { OR: messageScope } },
          select: { id: true, originalName: true, mimeType: true, size: true, createdAt: true, message: { select: { id: true, channelId: true, channel: { select: { name: true, isDM: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: PER_TYPE,
        })
      : Promise.resolve([]),
  ]);

  return {
    channels: channels.map((c) => ({ id: c.id, name: c.name, visibility: c.visibility, archived: c.archivedAt !== null, projectId: c.projectId, isMember: c.members.length > 0 })),
    people: people.map((p) => ({ id: p.id, username: p.username, displayName: p.profile?.displayName ?? null, title: p.profile?.title ?? null })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, key: p.key, status: p.status, archived: p.archivedAt !== null, visibility: p.visibility })),
    tasks: tasks
      .map((t) => taskView(t, { withProject: true }))
      .sort((a, b) => Number(CLOSED_STATUSES.includes(a.status)) - Number(CLOSED_STATUSES.includes(b.status))),
    files: files.map((f) => ({
      id: f.id,
      name: f.originalName,
      type: f.mimeType,
      size: f.size,
      url: attachmentPath(f.id),
      createdAt: f.createdAt,
      messageId: f.message?.id ?? null,
      channelId: f.message?.channelId ?? null,
      channelName: f.message?.channel.isDM ? null : f.message?.channel.name ?? null,
    })),
  };
};
