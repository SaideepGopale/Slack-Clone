import { prisma } from '../../lib/prisma';

export const listUsers = () =>
  prisma.user.findMany({ select: { id: true, username: true } });

// Called whenever the caller switches into a workspace (see
// WorkspaceLayout.tsx) — kept in sync so login/signup can tell the frontend
// where to land them next time, instead of always defaulting to whichever
// workspace happens to be first in the list.
export const setLastActiveWorkspace = (userId: string, workspaceId: string) =>
  prisma.user.update({ where: { id: userId }, data: { lastActiveWorkspaceId: workspaceId } });
