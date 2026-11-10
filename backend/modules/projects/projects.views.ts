import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

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
  // Batch 3/D: public channels only — summaries go to every project viewer,
  // and private channels must not be counted for people outside them.
  _count: { select: { members: true, channels: { where: { visibility: 'PUBLIC', isDM: false } } } },
} satisfies Prisma.ProjectSelect;

type ProjectSummaryRow = Prisma.ProjectGetPayload<{ select: typeof projectSummarySelect }>;

export const projectSummary = (row: ProjectSummaryRow) => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  description: row.description,
  visibility: row.visibility,
  archived: row.archivedAt !== null,
  archivedAt: row.archivedAt,
  memberCount: row._count.members,
  channelCount: row._count.channels,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type ProjectSummary = ReturnType<typeof projectSummary>;

export const loadProjectSummary = async (projectId: string): Promise<ProjectSummary | null> => {
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: projectSummarySelect });
  return row ? projectSummary(row) : null;
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
