import { prisma } from '../../lib/prisma';
import { getSocketServer, notifyUser } from '../../sockets/registry';
import { projectAudience } from '../projects/projects.realtime';
import { workNotificationView } from './tasks.service';
import type { TaskView } from './tasks.views';

/**
 * T.33 — task events go to exactly the project's audience (the same rooms as
 * project events: lib/policy 'project.view'), so a private project's tasks
 * never reach a socket that could not load them over REST. Notifications go
 * to their recipient's personal room only.
 *
 * T.38 — a private assignment's events go only to the people who may load it
 * (lib/policy canPrivateTask): its assignee, its creator and the leads (the
 * workspace owner and admins, the project's owners, organization owners and
 * admins) — and of those only people inside the workspace. Never to the
 * project's or workspace's other members.
 */
const userRoom = (userId: string) => `user:${userId}`;

export interface PrivateAssignmentRef {
  workspaceId: string;
  projectId: string;
  assigneeId: string | null;
  creatorId: string | null;
}

export const privateAssignmentAudience = async (task: PrivateAssignmentRef): Promise<string[]> => {
  const workspace = await prisma.workspace.findUnique({ where: { id: task.workspaceId }, select: { ownerId: true, organizationId: true } });
  if (!workspace) return [];
  const [admins, projectOwners, organizationManagers] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId: task.workspaceId, role: 'ADMIN' }, select: { userId: true } }),
    prisma.projectMember.findMany({ where: { projectId: task.projectId, role: 'OWNER' }, select: { userId: true } }),
    workspace.organizationId
      ? prisma.organizationMember.findMany({ where: { organizationId: workspace.organizationId, role: { in: ['OWNER', 'ADMIN'] } }, select: { userId: true } })
      : Promise.resolve([]),
  ]);
  const candidates = new Set(
    [task.assigneeId, task.creatorId, workspace.ownerId, ...admins.map((m) => m.userId), ...projectOwners.map((m) => m.userId), ...organizationManagers.map((m) => m.userId)].filter(
      (id): id is string => !!id
    )
  );
  // Only people inside the workspace (the owner always is).
  const inside = await prisma.workspaceMember.findMany({ where: { workspaceId: task.workspaceId, userId: { in: [...candidates] } }, select: { userId: true } });
  const allowed = new Set(inside.map((m) => m.userId));
  allowed.add(workspace.ownerId);
  return [...allowed].map(userRoom);
};

const emitToProject = async (projectId: string, event: string, payload: unknown) => {
  const io = getSocketServer();
  if (!io) return;
  const audience = await projectAudience(projectId);
  if (audience && audience.rooms.length > 0) io.to(audience.rooms).emit(event, payload);
};

const emitToPrivateAudience = async (task: PrivateAssignmentRef, event: string, payload: unknown) => {
  const io = getSocketServer();
  if (!io) return;
  const rooms = await privateAssignmentAudience(task);
  if (rooms.length > 0) io.to(rooms).emit(event, payload);
};

const privateRef = (task: TaskView): PrivateAssignmentRef => ({
  workspaceId: task.workspaceId,
  projectId: task.projectId,
  assigneeId: task.assignee?.id ?? null,
  creatorId: task.creator?.id ?? null,
});

export const announceTaskUpserted = (task: TaskView) =>
  task.assigneeOnly ? emitToPrivateAudience(privateRef(task), 'task:upserted', { task }) : emitToProject(task.projectId, 'task:upserted', { task });

export const announceTaskDeleted = (projectId: string, taskId: string, privateAssignment?: PrivateAssignmentRef | null) =>
  privateAssignment
    ? emitToPrivateAudience(privateAssignment, 'task:deleted', { taskId, projectId })
    : emitToProject(projectId, 'task:deleted', { taskId, projectId });

/** T.38: someone lost access to a task (a private assignment was reassigned away from them). */
export const announceTaskGoneFor = (userId: string, projectId: string, taskId: string) => {
  notifyUser(userId, 'task:deleted', { taskId, projectId });
};

export const pushWorkNotifications = (rows: (Parameters<typeof workNotificationView>[0] & { userId: string })[]) => {
  for (const row of rows) notifyUser(row.userId, 'work:notification', { notification: workNotificationView(row) });
};

/** Fire-and-forget wrapper: a failed broadcast never fails the request that caused it. */
export const quietly = (promise: Promise<unknown> | void) => {
  if (promise) promise.catch((err) => console.error('task realtime failed:', err instanceof Error ? err.message : err));
};
