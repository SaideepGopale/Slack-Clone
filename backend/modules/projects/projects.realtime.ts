import { ProjectVisibilityName } from '../../lib/policy';
import { prisma } from '../../lib/prisma';
import { getSocketServer, notifyUser, workspaceRoom } from '../../sockets/registry';
import { revokeChannelAccess } from '../../sockets/revocation';
import type { ChannelPlacementResult, ProjectMembershipEnded } from './projects.service';
import { loadProjectSummary, ProjectMemberView } from './projects.views';

/**
 * Real-time fan-out for projects. The audience mirrors lib/policy
 * 'project.view', so a private project's events never reach anyone who could
 * not fetch the project over REST:
 *   PUBLIC  → `ws:<workspaceId>` (every connected workspace member)
 *             + organization managers' personal rooms;
 *   PRIVATE → personal rooms of project members, the workspace owner and
 *             admins, and organization OWNER/ADMINs.
 *
 * Events: project:created, project:updated, project:removed (caller lost
 * visibility), project:member_added / _removed / _updated,
 * project:channel_added / _removed, and channel:project_changed (to the
 * channel's own room, so its members can regroup it).
 */

interface ProjectAudience {
  workspaceId: string;
  visibility: ProjectVisibilityName;
  rooms: string[];
}

const userRoom = (userId: string) => `user:${userId}`;

export const projectAudience = async (projectId: string): Promise<ProjectAudience | null> => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      visibility: true,
      members: { select: { userId: true } },
      workspace: {
        select: {
          ownerId: true,
          members: { where: { role: 'ADMIN' }, select: { userId: true } },
          organization: {
            select: { members: { where: { role: { in: ['OWNER', 'ADMIN'] } }, select: { userId: true } } },
          },
        },
      },
    },
  });
  if (!project) return null;
  const organizationManagers = project.workspace.organization?.members.map((m) => m.userId) ?? [];
  const userIds =
    project.visibility === 'PUBLIC'
      ? organizationManagers
      : [
          ...project.members.map((m) => m.userId),
          project.workspace.ownerId,
          ...project.workspace.members.map((m) => m.userId),
          ...organizationManagers,
        ];
  const rooms = [...new Set(userIds)].map(userRoom);
  if (project.visibility === 'PUBLIC') rooms.unshift(workspaceRoom(project.workspaceId));
  return { workspaceId: project.workspaceId, visibility: project.visibility, rooms };
};

const emit = (audience: ProjectAudience, event: string, payload: unknown) => {
  const io = getSocketServer();
  if (io && audience.rooms.length > 0) io.to(audience.rooms).emit(event, payload);
};

/** Re-broadcasts the project summary (counts, name, archive state…) to its current audience. */
const broadcastSummary = async (projectId: string, event: 'project:created' | 'project:updated', audience?: ProjectAudience | null) => {
  const [resolved, project] = await Promise.all([audience ?? projectAudience(projectId), loadProjectSummary(projectId)]);
  if (resolved && project) emit(resolved, event, { project });
};

export const announceProjectCreated = (projectId: string) => broadcastSummary(projectId, 'project:created');

/**
 * After an update/archive/restore. When a PUBLIC project became PRIVATE,
 * workspace members outside the new audience are told to drop it first
 * (disjoint sets, so nobody receives both events).
 */
export const announceProjectUpdated = async (projectId: string, previousVisibility?: ProjectVisibilityName) => {
  const audience = await projectAudience(projectId);
  if (!audience) return;
  if (previousVisibility === 'PUBLIC' && audience.visibility === 'PRIVATE') {
    getSocketServer()
      ?.to(workspaceRoom(audience.workspaceId))
      .except(audience.rooms)
      .emit('project:removed', { projectId, workspaceId: audience.workspaceId });
  }
  await broadcastSummary(projectId, 'project:updated', audience);
};

export const announceMemberAdded = async (projectId: string, workspaceId: string, member: ProjectMemberView) => {
  const audience = await projectAudience(projectId);
  if (!audience) return;
  emit(audience, 'project:member_added', { projectId, workspaceId, member });
  await broadcastSummary(projectId, 'project:updated', audience);
};

export const announceMembersUpdated = async (projectId: string, workspaceId: string, members: ProjectMemberView[]) => {
  if (members.length === 0) return;
  const audience = await projectAudience(projectId);
  if (!audience) return;
  for (const member of members) emit(audience, 'project:member_updated', { projectId, workspaceId, member });
};

/**
 * After removal/leave: evict the user's sockets from the private project's
 * channel rooms immediately, tell their clients, then update the audience.
 */
export const announceMembershipEnded = async (ended: ProjectMembershipEnded) => {
  const { projectId, workspaceId, userId, channelIds } = ended;
  await revokeChannelAccess(userId, channelIds);
  for (const channelId of channelIds) notifyUser(userId, 'conversation:removed', { channelId });
  if (ended.visibility === 'PRIVATE') notifyUser(userId, 'project:removed', { projectId, workspaceId });
  const audience = await projectAudience(projectId);
  if (!audience) return;
  emit(audience, 'project:member_removed', { projectId, workspaceId, userId });
  await broadcastSummary(projectId, 'project:updated', audience);
};

/** Workspace detach (removed / left / organization removal) ended these project memberships. */
export const announceWorkspaceDetachFromProjects = async (userId: string, projectIds: string[]) => {
  for (const projectId of projectIds) {
    const audience = await projectAudience(projectId);
    if (!audience) continue;
    emit(audience, 'project:member_removed', { projectId, workspaceId: audience.workspaceId, userId });
    await broadcastSummary(projectId, 'project:updated', audience);
  }
};

export const announceChannelPlacement = async (result: ChannelPlacementResult, added: boolean) => {
  if (!result.moved) return;
  const { projectId, workspaceId, channel } = result;
  const audience = await projectAudience(projectId);
  // Batch 3/D: a PRIVATE channel's existence is only for its own members —
  // they hear about the move through channel:project_changed below.
  if (audience && result.visibility === 'PUBLIC') {
    emit(
      audience,
      added ? 'project:channel_added' : 'project:channel_removed',
      added ? { projectId, workspaceId, channel } : { projectId, workspaceId, channelId: channel.id }
    );
    await broadcastSummary(projectId, 'project:updated', audience);
  }
  getSocketServer()
    ?.to(channel.id)
    .emit('channel:project_changed', { channelId: channel.id, workspaceId, projectId: added ? projectId : null });
};
