import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { TaskCounts, taskCountsByProject } from '../tasks/taskCounts';
import { projectKey } from '../tasks/tasks.views';

/**
 * Response shapes for projects. Summaries carry no per-viewer fields, so the
 * same payload can be broadcast to a whole audience; per-viewer fields
 * (myRole, capabilities) are added only to direct REST responses.
 */

export const projectSummarySelect = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  visibility: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  // T.33: lifecycle and task settings.
  status: true,
  key: true,
  requireReview: true,
  startDate: true,
  dueDate: true,
  // Batch 3/D: public channels only — summaries go to every project viewer,
  // and private channels must not be counted for people outside them.
  _count: { select: { members: true, channels: { where: { visibility: 'PUBLIC', isDM: false } } } },
} satisfies Prisma.ProjectSelect;

type ProjectSummaryRow = Prisma.ProjectGetPayload<{ select: typeof projectSummarySelect }>;

const EMPTY_COUNTS: TaskCounts = { total: 0, open: 0, done: 0, overdue: 0 };

export const projectSummary = (row: ProjectSummaryRow, taskCounts: TaskCounts = EMPTY_COUNTS) => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  description: row.description,
  visibility: row.visibility,
  archived: row.archivedAt !== null,
  archivedAt: row.archivedAt,
  memberCount: row._count.members,
  channelCount: row._count.channels,
  status: row.status,
  key: projectKey(row),
  requireReview: row.requireReview,
  startDate: row.startDate,
  dueDate: row.dueDate,
  taskCounts,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type ProjectSummary = ReturnType<typeof projectSummary>;

export const loadProjectSummary = async (projectId: string): Promise<ProjectSummary | null> => {
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: projectSummarySelect });
  if (!row) return null;
  return projectSummary(row, (await taskCountsByProject([row.id])).get(row.id));
};

// Usernames only — project listings never expose emails or read positions.
export const projectMemberSelect = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, username: true } },
} satisfies Prisma.ProjectMemberSelect;

type ProjectMemberRow = Prisma.ProjectMemberGetPayload<{ select: typeof projectMemberSelect }>;

export const projectMemberView = (row: ProjectMemberRow) => ({
  userId: row.user.id,
  role: row.role,
  joinedAt: row.createdAt,
  user: row.user,
});

export type ProjectMemberView = ReturnType<typeof projectMemberView>;

export const projectChannelView = (channel: { id: string; name: string | null; description: string | null; icon: string | null }) => ({
  id: channel.id,
  name: channel.name,
  description: channel.description,
  icon: channel.icon,
});
