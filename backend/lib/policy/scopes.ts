import { Prisma } from '@prisma/client';
import { canManageWorkspace, WorkspaceActor } from './policy';

/**
 * Prisma query scopes that mirror the pure policy rules, so listings can be
 * filtered in SQL instead of loading everything. They never widen access:
 * callers that list projects still re-check each row with canProject().
 */

/** Projects of a workspace the actor may see (mirrors canProject 'project.view'). */
export const visibleProjectsWhere = (actor: WorkspaceActor): Prisma.ProjectWhereInput => {
  if (canManageWorkspace(actor)) return { workspaceId: actor.workspaceId };
  if (actor.workspaceRole === null) return { id: { in: [] } };
  return {
    workspaceId: actor.workspaceId,
    OR: [{ visibility: 'PUBLIC' }, { members: { some: { userId: actor.userId } } }],
  };
};

/**
 * Channels whose project (if any) lets `userId` in — mirrors
 * projectAllowsChannelAccess(). Combine with the usual channel/workspace
 * membership filters; on its own it grants nothing.
 */
export const projectChannelAccessWhere = (userId: string): Prisma.ChannelWhereInput => ({
  OR: [
    { projectId: null },
    { project: { visibility: 'PUBLIC' } },
    { project: { members: { some: { userId } } } },
  ],
});

/**
 * Channels the actor may *discover* in a workspace (browse list, counts):
 * public channels their project access allows, plus channels they belong to.
 * Workspace managers also see private channels (management metadata only —
 * they still can't read or join them). Mirrors canChannel('channel.view').
 */
export const discoverableChannelsWhere = (actor: WorkspaceActor): Prisma.ChannelWhereInput => {
  if (canManageWorkspace(actor)) return { workspaceId: actor.workspaceId, isDM: false };
  if (actor.workspaceRole === null) return { id: { in: [] } };
  return {
    workspaceId: actor.workspaceId,
    isDM: false,
    AND: [
      projectChannelAccessWhere(actor.userId),
      { OR: [{ visibility: 'PUBLIC' }, { members: { some: { userId: actor.userId } } }] },
    ],
  };
};

/** Every channel/DM a user can see, without a workspace actor (cross-workspace counts). */
export const visibleChannelsWhere = (userId: string): Prisma.ChannelWhereInput => ({
  AND: [
    projectChannelAccessWhere(userId),
    { OR: [{ isDM: false, visibility: 'PUBLIC' }, { members: { some: { userId } } }] },
  ],
});
