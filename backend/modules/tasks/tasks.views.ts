import { Prisma, TaskStatus } from '@prisma/client';

/**
 * T.33 — the JSON shapes of tasks (see the API contract in the T.33 section
 * of entireanalysis.md). Every list and detail goes through these selects, so
 * no endpoint can leak a field (e.g. an e-mail) by accident.
 */
export const TASK_STATUSES: TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELLED'];
export const CLOSED_STATUSES: TaskStatus[] = ['DONE', 'CANCELLED'];
export const isClosed = (status: TaskStatus) => CLOSED_STATUSES.includes(status);

export const userRefSelect = { id: true, username: true, profile: { select: { displayName: true } } } as const;
type UserRefRow = { id: string; username: string; profile: { displayName: string | null } | null };
export const userRef = (u: UserRefRow | null) => (u ? { id: u.id, username: u.username, displayName: u.profile?.displayName ?? null } : null);

/** Short project code: the explicit key, else initials/letters of the name. */
export const projectKey = (project: { key: string | null; name: string }) => {
  if (project.key) return project.key;
  const words = project.name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '');
  const key = (initials.length >= 2 ? initials : (words[0] ?? '')).slice(0, 4);
  return key.length >= 2 ? key : 'TASK';
};

export const taskSelect = {
  id: true,
  projectId: true,
  workspaceId: true,
  number: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  parentId: true,
  startDate: true,
  dueDate: true,
  estimateHours: true,
  actualHours: true,
  labels: true,
  position: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  creatorId: true,
  assigneeId: true,
  assigneeOnly: true,
  creator: { select: userRefSelect },
  assignee: { select: userRefSelect },
  project: { select: { id: true, name: true, key: true } },
  _count: { select: { subtasks: true, comments: true } },
  subtasks: { where: { status: 'DONE' }, select: { id: true } },
  dependencies: { where: { dependsOn: { status: { notIn: CLOSED_STATUSES } } }, select: { id: true } },
} satisfies Prisma.TaskSelect;

export type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

export const taskView = (row: TaskRow, options: { withProject?: boolean; now?: number } = {}) => {
  const now = options.now ?? Date.now();
  const key = projectKey(row.project);
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    number: row.number,
    identifier: `${key}-${row.number}`,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignee: userRef(row.assignee),
    creator: userRef(row.creator),
    // T.38: a private assignment (assignee, creator and leads only).
    assigneeOnly: row.assigneeOnly,
    parentId: row.parentId,
    startDate: row.startDate,
    dueDate: row.dueDate,
    estimateHours: row.estimateHours,
    actualHours: row.actualHours,
    labels: row.labels,
    position: row.position,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    subtaskCount: row._count.subtasks,
    subtasksDone: row.subtasks.length,
    commentCount: row._count.comments,
    openBlockerCount: row.dependencies.length,
    overdue: !!row.dueDate && row.dueDate.getTime() < now && !isClosed(row.status),
    ...(options.withProject ? { project: { id: row.project.id, name: row.project.name, key } } : {}),
  };
};
export type TaskView = ReturnType<typeof taskView>;

export const taskRefSelect = { id: true, number: true, title: true, status: true, project: { select: { key: true, name: true } } } as const;
type TaskRefRow = { id: string; number: number; title: string; status: TaskStatus; project: { key: string | null; name: string } };
export const taskRef = (row: TaskRefRow) => ({ id: row.id, identifier: `${projectKey(row.project)}-${row.number}`, title: row.title, status: row.status });

/**
 * T.38 — the tasks a NON-lead may see among those of projects they can view:
 * everything that is not a private assignment, plus private assignments that
 * are theirs (as assignee or creator). Leads see everything (no filter).
 */
export const privateAssignmentFilter = (userId: string): Prisma.TaskWhereInput => ({
  OR: [{ assigneeOnly: false }, { assigneeId: userId }, { creatorId: userId }],
});
