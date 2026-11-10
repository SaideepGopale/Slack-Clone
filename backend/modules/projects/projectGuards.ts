import { Prisma } from '@prisma/client';
import { isGeneralChannelName, projectAllowsChannelAccess, ProjectVisibilityName } from '../../lib/policy';

type Tx = Prisma.TransactionClient;

/**
 * Row-lock protocol that keeps "a PRIVATE project's channels only contain
 * project members" true under concurrency (Batch 3/C).
 *
 *   channel entry (join / add member): Channel FOR SHARE → Project FOR SHARE
 *   move channel into/out of project:  Channel FOR NO KEY UPDATE → Project FOR UPDATE
 *   visibility change / member removal / ownership transfer: Project FOR UPDATE
 *
 * Writers that touch both rows always lock the channel first, and the
 * project-only writers never wait on a channel row, so the order can't
 * deadlock. getChannelAccess() re-checks the rule on every read anyway
 * (defense in depth), so a bug here can't turn into a content leak.
 */

export const isGeneralChannel = (channel: { name: string | null }) => isGeneralChannelName(channel.name);

/**
 * Shared lock on a channel row; returns its current project (null = workspace
 * level) and archived state (Batch 3/D), or undefined if gone.
 */
export const lockChannelForEntry = async (
  tx: Tx,
  channelId: string
): Promise<{ projectId: string | null; archived: boolean } | undefined> => {
  const rows = await tx.$queryRaw<{ projectId: string | null; archived: boolean }[]>`
    SELECT "projectId", ("archivedAt" IS NOT NULL) AS "archived" FROM "Channel" WHERE "id" = ${channelId} FOR SHARE`;
  return rows[0];
};

/**
 * Exclusive (non-key) lock on a channel row for moving it between projects or
 * changing its settings/roles (Batch 3/D).
 */
export const lockChannelForPlacement = async (
  tx: Tx,
  channelId: string
): Promise<{ projectId: string | null; archived: boolean; visibility: 'PUBLIC' | 'PRIVATE' } | undefined> => {
  const rows = await tx.$queryRaw<{ projectId: string | null; archived: boolean; visibility: 'PUBLIC' | 'PRIVATE' }[]>`
    SELECT "projectId", ("archivedAt" IS NOT NULL) AS "archived", "visibility"::text AS "visibility"
    FROM "Channel" WHERE "id" = ${channelId} FOR NO KEY UPDATE`;
  return rows[0];
};

/** Shared lock on a project; true when `userId` may be inside its channels. */
export const projectAdmitsUser = async (tx: Tx, projectId: string, userId: string): Promise<boolean> => {
  const rows = await tx.$queryRaw<{ visibility: ProjectVisibilityName; isMember: boolean }[]>`
    SELECT p."visibility"::text AS "visibility",
           EXISTS (SELECT 1 FROM "ProjectMember" pm WHERE pm."projectId" = p."id" AND pm."userId" = ${userId}) AS "isMember"
    FROM "Project" p WHERE p."id" = ${projectId} FOR SHARE`;
  const row = rows[0];
  return !row || projectAllowsChannelAccess(row, row.isMember);
};

/** Exclusive lock on a project row; returns its lifecycle fields (undefined if gone). */
export const lockProjectForUpdate = async (
  tx: Tx,
  projectId: string
): Promise<{ visibility: ProjectVisibilityName; archived: boolean; workspaceId: string } | undefined> => {
  const rows = await tx.$queryRaw<{ visibility: ProjectVisibilityName; archived: boolean; workspaceId: string }[]>`
    SELECT "visibility"::text AS "visibility", ("archivedAt" IS NOT NULL) AS "archived", "workspaceId"
    FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  return rows[0];
};
