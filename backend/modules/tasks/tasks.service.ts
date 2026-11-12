import { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import {
  assertProject,
  assertTask,
  canManageWorkspace,
  canTask,
  isProjectLead,
  loadProjectActor,
  loadWorkspaceActor,
  ProjectActor,
  taskCapabilities,
  visibleProjectsWhere,
} from '../../lib/policy';
import { attachmentPath } from '../../lib/attachments';
import { CLOSED_STATUSES, isClosed, privateAssignmentFilter, projectKey, TASK_STATUSES, taskRef, taskRefSelect, taskSelect, taskView, TaskView, userRef, userRefSelect } from './tasks.views';

/**
 * T.33 — tasks: CRUD, board moves, comments, dependencies, cross-project
 * views (my tasks, workload) and reports. Authorization is lib/policy
 * (canTask) on a ProjectActor loaded from the database for every request —
 * never from ids or roles sent by the client. Every task is reached through
 * its project, so tenant isolation is the project's (workspace) boundary.
 */

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
const COMMENT_MAX = 5_000;
const LABELS_MAX = 10;
const LABEL_MAX = 30;
const HOURS_MAX = 10_000;
const LIST_MAX = 500;
export const POSITION_GAP = 1024;

const PRIORITIES: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

// ---- input ---------------------------------------------------------------------

export const parseTitle = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'A task title is required.');
  const title = value.replace(/\s+/g, ' ').trim();
  if (title.length > TITLE_MAX) throw new HttpError(400, `Task titles must be ${TITLE_MAX} characters or fewer.`);
  return title;
};

export const parseDescription = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'The description must be text.');
  if (value.length > DESCRIPTION_MAX) throw new HttpError(400, `Descriptions must be ${DESCRIPTION_MAX} characters or fewer.`);
  return value.trim() || null;
};

export const parseStatus = (value: unknown): TaskStatus => {
  if (typeof value !== 'string' || !TASK_STATUSES.includes(value as TaskStatus)) throw new HttpError(400, 'Unknown task status.');
  return value as TaskStatus;
};

export const parsePriority = (value: unknown): TaskPriority => {
  if (typeof value !== 'string' || !PRIORITIES.includes(value as TaskPriority)) throw new HttpError(400, 'Unknown task priority.');
  return value as TaskPriority;
};

export const parseDate = (value: unknown, label: string): Date | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 40) throw new HttpError(400, `${label} must be a date.`);
  const date = new Date(value);
  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 2000 || year > 2100) throw new HttpError(400, `${label} must be a valid date.`);
  return date;
};

const parseHours = (value: unknown, label: string): number | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > HOURS_MAX) {
    throw new HttpError(400, `${label} must be a number of hours between 0 and ${HOURS_MAX}.`);
  }
  return Math.round(value * 100) / 100;
};

const parseLabels = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new HttpError(400, 'Labels must be a list.');
  const labels = Array.from(
    new Set(
      value.map((l) => {
        if (typeof l !== 'string' || !l.trim()) throw new HttpError(400, 'Labels must be non-empty text.');
        const label = l.trim().replace(/\s+/g, ' ');
        if (label.length > LABEL_MAX) throw new HttpError(400, `Labels must be ${LABEL_MAX} characters or fewer.`);
        return label;
      })
    )
  );
  if (labels.length > LABELS_MAX) throw new HttpError(400, `A task can have at most ${LABELS_MAX} labels.`);
  return labels;
};

const parseOptionalUuid = (value: unknown, label: string): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (!isUuid(value)) throw new HttpError(400, `${label} is invalid.`);
  return value;
};

// ---- loading -------------------------------------------------------------------

interface TaskContext {
  actor: ProjectActor & { workspaceId: string };
  task: {
    id: string;
    projectId: string;
    workspaceId: string;
    number: number;
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    creatorId: string | null;
    assigneeId: string | null;
    parentId: string | null;
    dueDate: Date | null;
    startDate: Date | null;
    assigneeOnly: boolean;
  };
  requireReview: boolean;
}

/** The task and the caller's actor on its project; 404 when either is not visible. */
const loadTaskContext = async (userId: string, taskId: unknown): Promise<TaskContext> => {
  if (!isUuid(taskId)) throw new HttpError(404, 'Task not found.');
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      workspaceId: true,
      number: true,
      title: true,
      status: true,
      priority: true,
      creatorId: true,
      assigneeId: true,
      parentId: true,
      dueDate: true,
      startDate: true,
      assigneeOnly: true,
      project: { select: { requireReview: true } },
    },
  });
  if (!task) throw new HttpError(404, 'Task not found.');
  const actor = await loadProjectActor(userId, task.projectId);
  // T.38: judged on the task itself (a private assignment is visible to its assignee even outside the project).
  assertTask(actor, 'task.view', task);
  const { project, ...rest } = task;
  return { actor, task: rest, requireReview: project.requireReview };
};

const loadTaskView = async (taskId: string, withProject = false): Promise<TaskView> => {
  const row = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: taskSelect });
  return taskView(row, { withProject });
};

/** An assignee must currently be a member of the project (and an active account in its workspace). */
const assertAssignable = async (projectId: string, workspaceId: string, userId: string) => {
  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId, user: { status: 'ACTIVE', workspaces: { some: { workspaceId } } } },
    select: { id: true },
  });
  if (!member) throw new HttpError(400, 'Tasks can only be assigned to members of this project.');
};

/** T.38: a private assignment's assignee must be an active member of the task's workspace (project membership not required). */
export const assertWorkspaceAssignable = async (workspaceId: string, userId: string) => {
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, user: { status: 'ACTIVE' } },
    select: { id: true },
  });
  if (!member) throw new HttpError(400, 'Tasks can only be assigned to active members of this workspace.');
};

/** Open dependencies that keep a task from being completed. */
const openBlockers = (taskId: string, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  db.task.findMany({
    where: { dependents: { some: { taskId } }, status: { notIn: CLOSED_STATUSES } },
    select: taskRefSelect,
    orderBy: { number: 'asc' },
  });

class BlockedError extends HttpError {
  constructor(public readonly blockers: ReturnType<typeof taskRef>[]) {
    super(409, `This task is blocked by ${blockers.map((b) => b.identifier).join(', ')}. Finish those first.`);
  }
}
export { BlockedError };

const assertNotBlocked = async (taskId: string, db: Prisma.TransactionClient | typeof prisma = prisma) => {
  const blockers = await openBlockers(taskId, db);
  if (blockers.length > 0) throw new BlockedError(blockers.map(taskRef));
};

export const recordActivity = (db: Prisma.TransactionClient | typeof prisma, taskId: string, actorId: string, type: string, data?: Prisma.InputJsonValue) =>
  db.taskActivity.create({ data: { taskId, actorId, type, data } });

// ---- notifications ---------------------------------------------------------------

export interface WorkNotificationDraft {
  userId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  actorId: string | null;
  type: string;
  title: string;
  body?: string | null;
}

/** Created after the change commits; the caller pushes them in real time. */
export const createWorkNotifications = async (drafts: WorkNotificationDraft[]) => {
  const unique = drafts.filter((d, i) => d.userId !== d.actorId && drafts.findIndex((x) => x.userId === d.userId && x.type === d.type) === i);
  if (unique.length === 0) return [];
  return prisma.$transaction(
    unique.map((d) =>
      prisma.workNotification.create({
        data: { ...d, title: d.title.slice(0, 300), body: d.body?.slice(0, 500) ?? null },
        select: workNotificationSelect,
      })
    )
  );
};

export const workNotificationSelect = {
  id: true,
  userId: true,
  type: true,
  title: true,
  body: true,
  taskId: true,
  projectId: true,
  workspaceId: true,
  readAt: true,
  createdAt: true,
  actor: { select: userRefSelect },
} satisfies Prisma.WorkNotificationSelect;

export const workNotificationView = (row: Prisma.WorkNotificationGetPayload<{ select: typeof workNotificationSelect }>) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  taskId: row.taskId,
  projectId: row.projectId,
  workspaceId: row.workspaceId,
  actor: userRef(row.actor),
  readAt: row.readAt,
  createdAt: row.createdAt,
});

// ---- list / create ---------------------------------------------------------------

export const csv = <T extends string>(value: unknown, parse: (v: unknown) => T): T[] | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  return value.split(',').slice(0, 10).map((v) => parse(v.trim()));
};

export const listTasks = async (userId: string, projectId: string, query: Record<string, unknown>) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.view');

  const where: Prisma.TaskWhereInput = { projectId: actor.projectId };
  // T.38: other people's private assignments are invisible to non-leads.
  if (!isProjectLead(actor)) where.AND = [privateAssignmentFilter(userId)];
  const statuses = csv(query.status, parseStatus);
  if (statuses) where.status = { in: statuses };
  const priorities = csv(query.priority, parsePriority);
  if (priorities) where.priority = { in: priorities };
  if (query.assigneeId === 'me') where.assigneeId = userId;
  else if (query.assigneeId === 'none') where.assigneeId = null;
  else if (query.assigneeId !== undefined) where.assigneeId = parseOptionalUuid(query.assigneeId, 'Assignee');
  if (typeof query.label === 'string' && query.label.trim()) where.labels = { has: query.label.trim().slice(0, LABEL_MAX) };
  if (typeof query.q === 'string' && query.q.trim()) {
    const q = query.q.trim().slice(0, 100);
    const number = /^\d+$/.test(q) ? Number(q) : /^[A-Za-z0-9]{1,6}-(\d+)$/.exec(q)?.[1];
    where.OR = [{ title: { contains: q, mode: 'insensitive' } }, ...(number !== undefined ? [{ number: Number(number) }] : [])];
  }
  const parent = query.parent ?? 'root';
  if (parent === 'root') where.parentId = null;
  else if (parent !== 'any') where.parentId = parseOptionalUuid(parent, 'Parent task');
  if (query.dueFrom !== undefined || query.dueTo !== undefined) {
    where.dueDate = {
      ...(query.dueFrom !== undefined ? { gte: parseDate(query.dueFrom, 'dueFrom') ?? undefined } : {}),
      ...(query.dueTo !== undefined ? { lte: parseDate(query.dueTo, 'dueTo') ?? undefined } : {}),
    };
  }
  const limit = Math.min(Math.max(Number(query.limit) || LIST_MAX, 1), LIST_MAX);
  const cursor = typeof query.cursor === 'string' && isUuid(query.cursor) ? query.cursor : null;

  const rows = await prisma.task.findMany({
    where,
    select: taskSelect,
    orderBy: [{ status: 'asc' }, { position: 'asc' }, { number: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  // Prisma orders enums by declaration order, which is the board order.
  return { tasks: page.map((r) => taskView(r)), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
};

export const createTask = async (userId: string, projectId: string, body: Record<string, unknown> | undefined) => {
  const actor = await loadProjectActor(userId, projectId);
  assertTask(actor, 'task.create');
  const title = parseTitle(body?.title);
  const description = parseDescription(body?.description);
  const status = body?.status !== undefined ? parseStatus(body.status) : 'TODO';
  const priority = body?.priority !== undefined ? parsePriority(body.priority) : 'MEDIUM';
  const assigneeId = parseOptionalUuid(body?.assigneeId, 'Assignee');
  const parentId = parseOptionalUuid(body?.parentId, 'Parent task');
  const startDate = body?.startDate !== undefined ? parseDate(body.startDate, 'Start date') : null;
  const dueDate = body?.dueDate !== undefined ? parseDate(body.dueDate, 'Due date') : null;
  const estimateHours = body?.estimateHours !== undefined ? parseHours(body.estimateHours, 'The estimate') : null;
  const labels = body?.labels !== undefined ? parseLabels(body.labels) : [];
  if (startDate && dueDate && dueDate < startDate) throw new HttpError(400, 'The due date cannot be before the start date.');

  if (assigneeId) {
    assertTask(actor, assigneeId === userId ? 'task.assignSelf' : 'task.assignOthers');
    await assertAssignable(actor.projectId, actor.workspaceId, assigneeId);
  }
  if (status === 'DONE') assertTask(actor, 'task.complete', { creatorId: userId, assigneeId }, { requireReview: (await projectSettings(actor.projectId)).requireReview });
  // T.38: a subtask of a private assignment is private too.
  let assigneeOnly = false;
  if (parentId) {
    const parent = await prisma.task.findUnique({ where: { id: parentId }, select: { projectId: true, parentId: true, assigneeOnly: true, assigneeId: true, creatorId: true } });
    if (!parent || parent.projectId !== actor.projectId || !canTask(actor, 'task.view', parent)) throw new HttpError(400, 'The parent task must be in the same project.');
    if (parent.parentId) throw new HttpError(400, 'Subtasks cannot have their own subtasks.');
    assigneeOnly = parent.assigneeOnly;
  }

  const created = await prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: actor.projectId },
      data: { taskSequence: { increment: 1 } },
      select: { taskSequence: true, archivedAt: true },
    });
    if (project.archivedAt) throw new HttpError(409, 'This project is archived. Restore it first.');
    const last = await tx.task.findFirst({ where: { projectId: actor.projectId, status, parentId }, orderBy: { position: 'desc' }, select: { position: true } });
    const task = await tx.task.create({
      data: {
        projectId: actor.projectId,
        workspaceId: actor.workspaceId,
        number: project.taskSequence,
        title,
        description,
        status,
        priority,
        creatorId: userId,
        assigneeId,
        parentId,
        startDate,
        dueDate,
        estimateHours,
        labels,
        position: (last?.position ?? 0) + POSITION_GAP,
        completedAt: status === 'DONE' ? new Date() : null,
        assigneeOnly,
      },
      select: { id: true },
    });
    await recordActivity(tx, task.id, userId, 'created', { status, ...(parentId ? { parentId } : {}) });
    if (parentId) await recordActivity(tx, parentId, userId, 'subtask_added', { taskId: task.id, title });
    return task;
  });

  const view = await loadTaskView(created.id);
  const notifications = assigneeId
    ? await createWorkNotifications([
        { userId: assigneeId, workspaceId: actor.workspaceId, projectId: actor.projectId, taskId: view.id, actorId: userId, type: 'task_assigned', title: `${view.identifier} ${view.title}`, body: 'You were assigned a new task.' },
      ])
    : [];
  return { task: view, notifications };
};

const projectSettings = (projectId: string) => prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { requireReview: true, name: true, key: true } });

// ---- detail ----------------------------------------------------------------------

export const getTask = async (userId: string, taskId: string) => {
  const { actor, task, requireReview } = await loadTaskContext(userId, taskId);
  // T.38: related tasks a non-lead may not see are left out.
  const visible: Prisma.TaskWhereInput = isProjectLead(actor) ? {} : privateAssignmentFilter(userId);
  const [row, parent, subtasks, blockedBy, blocking, comments, activity, attachments, project] = await Promise.all([
    prisma.task.findUniqueOrThrow({ where: { id: task.id }, select: taskSelect }),
    task.parentId ? prisma.task.findFirst({ where: { id: task.parentId, ...visible }, select: taskRefSelect }) : null,
    prisma.task.findMany({ where: { parentId: task.id, ...visible }, select: taskSelect, orderBy: [{ position: 'asc' }, { number: 'asc' }], take: 200 }),
    prisma.task.findMany({ where: { dependents: { some: { taskId: task.id } }, ...visible }, select: taskRefSelect, orderBy: { number: 'asc' } }),
    prisma.task.findMany({ where: { dependencies: { some: { dependsOnId: task.id } }, ...visible }, select: taskRefSelect, orderBy: { number: 'asc' } }),
    prisma.taskComment.findMany({ where: { taskId: task.id }, select: commentSelect, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.taskActivity.findMany({
      where: { taskId: task.id },
      select: { id: true, type: true, data: true, createdAt: true, actor: { select: userRefSelect } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.attachment.findMany({ where: { taskId: task.id }, select: { id: true, originalName: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' } }),
    prisma.project.findUniqueOrThrow({ where: { id: task.projectId }, select: { id: true, name: true, key: true, workspaceId: true, archivedAt: true } }),
  ]);
  const lead = isProjectLead(actor);
  return {
    ...taskView(row),
    project: { id: project.id, name: project.name, key: projectKey(project), workspaceId: project.workspaceId, requireReview, archived: project.archivedAt !== null },
    parent: parent ? taskRef(parent) : null,
    subtasks: subtasks.map((s) => taskView(s)),
    blockedBy: blockedBy.map(taskRef),
    blocking: blocking.map(taskRef),
    comments: comments.reverse().map((c) => commentView(c, userId, lead && !actor.archived)),
    activity: activity.map((a) => ({ id: a.id, type: a.type, data: a.data ?? {}, actor: userRef(a.actor), createdAt: a.createdAt })),
    attachments: attachments.map((a) => ({ id: a.id, url: attachmentPath(a.id), name: a.originalName, type: a.mimeType, size: a.size })),
    capabilities: taskCapabilities(actor, task, requireReview),
  };
};

// ---- update / move / delete -------------------------------------------------------

const changeSummary = (changes: string[]) => changes.join(', ');

export const updateTask = async (userId: string, taskId: string, body: Record<string, unknown> | undefined) => {
  const ctx = await loadTaskContext(userId, taskId);
  const { actor, task, requireReview } = ctx;
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Nothing to update.');

  const data: Prisma.TaskUncheckedUpdateInput = {};
  const activity: { type: string; data: Prisma.InputJsonValue }[] = [];
  const fieldsTouched = Object.keys(body).filter((k) => body[k] !== undefined);
  const contentFields = ['title', 'description', 'priority', 'startDate', 'dueDate', 'estimateHours', 'actualHours', 'labels'];
  if (fieldsTouched.some((k) => contentFields.includes(k))) assertTask(actor, 'task.update', task);

  if (body.title !== undefined) {
    const title = parseTitle(body.title);
    if (title !== task.title) {
      data.title = title;
      activity.push({ type: 'title', data: { from: task.title, to: title } });
    }
  }
  if (body.description !== undefined) {
    data.description = parseDescription(body.description);
    activity.push({ type: 'description', data: {} });
  }
  if (body.priority !== undefined) {
    const priority = parsePriority(body.priority);
    if (priority !== task.priority) {
      data.priority = priority;
      activity.push({ type: 'priority', data: { from: task.priority, to: priority } });
    }
  }
  const startDate = body.startDate !== undefined ? parseDate(body.startDate, 'Start date') : task.startDate;
  const dueDate = body.dueDate !== undefined ? parseDate(body.dueDate, 'Due date') : task.dueDate;
  if (startDate && dueDate && dueDate < startDate) throw new HttpError(400, 'The due date cannot be before the start date.');
  if (body.startDate !== undefined) {
    data.startDate = startDate;
    activity.push({ type: 'start_date', data: { from: task.startDate?.toISOString() ?? null, to: startDate?.toISOString() ?? null } });
  }
  if (body.dueDate !== undefined) {
    data.dueDate = dueDate;
    // A new due date may need a new reminder.
    data.overdueNotifiedAt = null;
    activity.push({ type: 'due_date', data: { from: task.dueDate?.toISOString() ?? null, to: dueDate?.toISOString() ?? null } });
  }
  if (body.estimateHours !== undefined) {
    data.estimateHours = parseHours(body.estimateHours, 'The estimate');
    activity.push({ type: 'estimate', data: { to: data.estimateHours as number | null } });
  }
  if (body.actualHours !== undefined) data.actualHours = parseHours(body.actualHours, 'Actual hours');
  if (body.labels !== undefined) {
    data.labels = parseLabels(body.labels);
    activity.push({ type: 'labels', data: { to: data.labels as string[] } });
  }

  let assigneeChanged = false;
  if (body.assigneeId !== undefined) {
    const assigneeId = parseOptionalUuid(body.assigneeId, 'Assignee');
    if (assigneeId !== task.assigneeId) {
      const selfOnly = (assigneeId === userId || assigneeId === null) && (task.assigneeId === null || task.assigneeId === userId);
      assertTask(actor, selfOnly ? 'task.assignSelf' : 'task.assignOthers', task);
      if (assigneeId) {
        if (task.assigneeOnly) await assertWorkspaceAssignable(task.workspaceId, assigneeId);
        else await assertAssignable(task.projectId, task.workspaceId, assigneeId);
      }
      data.assigneeId = assigneeId;
      assigneeChanged = true;
    }
  }

  let statusChange: { from: TaskStatus; to: TaskStatus } | null = null;
  if (body.status !== undefined) {
    const status = parseStatus(body.status);
    if (status !== task.status) {
      assertTask(actor, status === 'DONE' ? 'task.complete' : 'task.changeStatus', task, { requireReview });
      // T.38: cancelling a private assignment is the lead's decision, not the assignee's.
      if (status === 'CANCELLED' && task.assigneeOnly) assertTask(actor, 'task.update', task);
      if (status === 'DONE') await assertNotBlocked(task.id);
      data.status = status;
      data.completedAt = status === 'DONE' ? new Date() : null;
      statusChange = { from: task.status, to: status };
    }
  }

  if (Object.keys(data).length === 0 && activity.length === 0) return { task: await loadTaskView(task.id), notifications: [], previousAssigneeId: null };

  await prisma.$transaction(async (tx) => {
    if (statusChange) {
      // Lands at the bottom of its new column.
      const last = await tx.task.findFirst({ where: { projectId: task.projectId, status: statusChange.to, parentId: task.parentId }, orderBy: { position: 'desc' }, select: { position: true } });
      data.position = (last?.position ?? 0) + POSITION_GAP;
    }
    await tx.task.update({ where: { id: task.id }, data });
    for (const a of activity) await recordActivity(tx, task.id, userId, a.type, a.data);
    if (statusChange) await recordActivity(tx, task.id, userId, 'status', statusChange);
    if (assigneeChanged) await recordActivity(tx, task.id, userId, 'assignee', { from: task.assigneeId, to: (data.assigneeId as string | null) ?? null });
  });

  const view = await loadTaskView(task.id);
  const drafts: WorkNotificationDraft[] = [];
  const base = { workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, actorId: userId, title: `${view.identifier} ${view.title}` };
  if (assigneeChanged && data.assigneeId) drafts.push({ ...base, userId: data.assigneeId as string, type: 'task_assigned', body: 'You were assigned this task.' });
  if (statusChange && task.creatorId) drafts.push({ ...base, userId: task.creatorId, type: 'task_status', body: `Status changed to ${statusChange.to.replace('_', ' ').toLowerCase()}.` });
  if (statusChange && task.assigneeId && task.assigneeId !== task.creatorId) drafts.push({ ...base, userId: task.assigneeId, type: 'task_status', body: `Status changed to ${statusChange.to.replace('_', ' ').toLowerCase()}.` });
  // T.38: the previous assignee of a private assignment loses access — the route tells their sockets.
  const previousAssigneeId = task.assigneeOnly && assigneeChanged && task.assigneeId ? task.assigneeId : null;
  return { task: view, notifications: await createWorkNotifications(drafts), changed: changeSummary(Object.keys(data)), previousAssigneeId };
};

/**
 * Board drag-and-drop: a new status and position between two neighbours of
 * the target column. Positions are fractional; when a gap gets too small the
 * column is renumbered in the same transaction.
 */
export const moveTask = async (userId: string, taskId: string, body: Record<string, unknown> | undefined) => {
  const { actor, task, requireReview } = await loadTaskContext(userId, taskId);
  const status = body?.status !== undefined ? parseStatus(body.status) : task.status;
  const prevId = parseOptionalUuid(body?.prevId, 'prevId');
  const nextId = parseOptionalUuid(body?.nextId, 'nextId');
  if (status !== task.status) {
    assertTask(actor, status === 'DONE' ? 'task.complete' : 'task.changeStatus', task, { requireReview });
    if (status === 'DONE') await assertNotBlocked(task.id);
  } else {
    // Reordering within a column: anyone who may work on the task.
    if (!canTask(actor, 'task.changeStatus', task) && !canTask(actor, 'task.update', task)) assertTask(actor, 'task.changeStatus', task);
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${task.projectId} FOR UPDATE`;
    const neighbours = await tx.task.findMany({
      where: { id: { in: [prevId, nextId].filter((x): x is string => !!x) } },
      select: { id: true, position: true, projectId: true, status: true, parentId: true },
    });
    const prev = neighbours.find((n) => n.id === prevId);
    const next = neighbours.find((n) => n.id === nextId);
    for (const n of [prev, next]) {
      if (n && (n.projectId !== task.projectId || n.status !== status || n.parentId !== task.parentId || n.id === task.id)) {
        throw new HttpError(400, 'Drop position is no longer valid. Refresh and try again.');
      }
    }
    if ((prevId && !prev) || (nextId && !next)) throw new HttpError(400, 'Drop position is no longer valid. Refresh and try again.');

    let position: number;
    if (prev && next) position = (prev.position + next.position) / 2;
    else if (prev) position = prev.position + POSITION_GAP;
    else if (next) position = next.position - POSITION_GAP;
    else {
      const last = await tx.task.findFirst({ where: { projectId: task.projectId, status, parentId: task.parentId, id: { not: task.id } }, orderBy: { position: 'desc' }, select: { position: true } });
      position = (last?.position ?? 0) + POSITION_GAP;
    }

    if (prev && next && next.position - prev.position < 1e-6) {
      // Renumber the column, keeping the intended order.
      const column = await tx.task.findMany({ where: { projectId: task.projectId, status, parentId: task.parentId, id: { not: task.id } }, orderBy: [{ position: 'asc' }, { number: 'asc' }], select: { id: true } });
      const ordered = column.map((c) => c.id);
      ordered.splice(ordered.indexOf(prev.id) + 1, 0, task.id);
      for (const [i, id] of ordered.entries()) await tx.task.update({ where: { id }, data: { position: (i + 1) * POSITION_GAP } });
    } else {
      await tx.task.update({ where: { id: task.id }, data: { position } });
    }
    if (status !== task.status) {
      await tx.task.update({ where: { id: task.id }, data: { status, completedAt: status === 'DONE' ? new Date() : null } });
      await recordActivity(tx, task.id, userId, 'status', { from: task.status, to: status });
    }
  });

  const view = await loadTaskView(task.id);
  const drafts: WorkNotificationDraft[] =
    status !== task.status && task.creatorId
      ? [{ userId: task.creatorId, workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, actorId: userId, type: 'task_status', title: `${view.identifier} ${view.title}`, body: `Status changed to ${status.replace('_', ' ').toLowerCase()}.` }]
      : [];
  return { task: view, notifications: await createWorkNotifications(drafts) };
};

export const deleteTask = async (userId: string, taskId: string) => {
  const { actor, task } = await loadTaskContext(userId, taskId);
  assertTask(actor, 'task.delete', task);
  const identifier = `${projectKey(await projectSettings(task.projectId))}-${task.number}`;
  await prisma.task.delete({ where: { id: task.id } });
  await logAuditEvent(userId, 'DELETE_TASK', 'TASK', task.id, `Deleted task ${identifier} "${task.title}"`);
  // T.38: who to tell about a deleted private assignment (its audience, not the project's).
  return {
    taskId: task.id,
    projectId: task.projectId,
    parentId: task.parentId,
    privateAssignment: task.assigneeOnly ? { workspaceId: task.workspaceId, projectId: task.projectId, assigneeId: task.assigneeId, creatorId: task.creatorId } : null,
  };
};

// ---- comments ----------------------------------------------------------------------

const commentSelect = { id: true, body: true, createdAt: true, editedAt: true, authorId: true, author: { select: userRefSelect } } as const;
type CommentRow = Prisma.TaskCommentGetPayload<{ select: typeof commentSelect }>;
const commentView = (c: CommentRow, viewerId: string, viewerIsActiveLead: boolean) => ({
  id: c.id,
  body: c.body,
  author: userRef(c.author),
  createdAt: c.createdAt,
  editedAt: c.editedAt,
  canEdit: c.authorId === viewerId,
  canDelete: c.authorId === viewerId || viewerIsActiveLead,
});

const parseComment = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'A comment cannot be empty.');
  if (value.length > COMMENT_MAX) throw new HttpError(400, `Comments must be ${COMMENT_MAX} characters or fewer.`);
  return value.trim();
};

export const listComments = async (userId: string, taskId: string, query: Record<string, unknown>) => {
  const { actor, task } = await loadTaskContext(userId, taskId);
  const cursor = typeof query.cursor === 'string' && isUuid(query.cursor) ? query.cursor : null;
  const rows = await prisma.taskComment.findMany({
    where: { taskId: task.id },
    select: commentSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 101,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, 100);
  const lead = isProjectLead(actor) && !actor.archived;
  return { comments: page.map((c) => commentView(c, userId, lead)), nextCursor: rows.length > 100 ? page[page.length - 1].id : null };
};

export const addComment = async (userId: string, taskId: string, body: Record<string, unknown> | undefined) => {
  const { actor, task } = await loadTaskContext(userId, taskId);
  assertTask(actor, 'task.comment', task);
  const text = parseComment(body?.body);
  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.taskComment.create({ data: { taskId: task.id, authorId: userId, body: text }, select: commentSelect });
    await recordActivity(tx, task.id, userId, 'comment', { commentId: created.id });
    return created;
  });
  const identifier = `${projectKey(await projectSettings(task.projectId))}-${task.number}`;
  const base = { workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, actorId: userId, type: 'task_comment', title: `${identifier} ${task.title}`, body: text.slice(0, 200) };
  const recipients = [task.assigneeId, task.creatorId].filter((id): id is string => !!id);
  const notifications = await createWorkNotifications(recipients.map((id) => ({ ...base, userId: id })));
  return { comment: commentView(comment, userId, isProjectLead(actor)), task, notifications };
};

const loadComment = async (userId: string, commentId: string) => {
  if (!isUuid(commentId)) throw new HttpError(404, 'Comment not found.');
  const comment = await prisma.taskComment.findUnique({ where: { id: commentId }, select: { id: true, taskId: true, authorId: true } });
  if (!comment) throw new HttpError(404, 'Comment not found.');
  const ctx = await loadTaskContext(userId, comment.taskId);
  return { comment, ...ctx };
};

export const editComment = async (userId: string, commentId: string, body: Record<string, unknown> | undefined) => {
  const { comment, actor } = await loadComment(userId, commentId);
  if (actor.archived) throw new HttpError(409, 'This project is archived. Restore it first.');
  if (comment.authorId !== userId) throw new HttpError(403, 'Only the author can edit a comment.');
  const updated = await prisma.taskComment.update({ where: { id: comment.id }, data: { body: parseComment(body?.body), editedAt: new Date() }, select: commentSelect });
  return commentView(updated, userId, isProjectLead(actor));
};

export const deleteComment = async (userId: string, commentId: string) => {
  const { comment, actor } = await loadComment(userId, commentId);
  if (actor.archived) throw new HttpError(409, 'This project is archived. Restore it first.');
  if (comment.authorId !== userId && !isProjectLead(actor)) throw new HttpError(403, 'Only the author or a project lead can delete a comment.');
  await prisma.taskComment.delete({ where: { id: comment.id } });
  return { taskId: comment.taskId };
};

// ---- dependencies ---------------------------------------------------------------------

export const addDependency = async (userId: string, taskId: string, body: Record<string, unknown> | undefined) => {
  const { actor, task } = await loadTaskContext(userId, taskId);
  assertTask(actor, 'task.update', task);
  const dependsOnId = parseOptionalUuid(body?.dependsOnId, 'The blocking task');
  if (!dependsOnId) throw new HttpError(400, 'Choose the task this one depends on.');
  if (dependsOnId === task.id) throw new HttpError(400, 'A task cannot depend on itself.');

  await prisma.$transaction(async (tx) => {
    // One dependency change per project at a time: two concurrent inserts
    // (A→B and B→A) cannot both pass the cycle check.
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${task.projectId} FOR UPDATE`;
    const target = await tx.task.findUnique({ where: { id: dependsOnId }, select: { projectId: true, assigneeOnly: true, assigneeId: true, creatorId: true } });
    // T.38: a task the caller may not see is answered like a missing one.
    if (!target || target.projectId !== task.projectId || !canTask(actor, 'task.view', target)) throw new HttpError(400, 'Dependencies must be between tasks of the same project.');

    // Would dependsOn (transitively) depend on this task? Breadth-first over
    // the project's dependency edges.
    const edges = await tx.taskDependency.findMany({ where: { task: { projectId: task.projectId } }, select: { taskId: true, dependsOnId: true } });
    const next = new Map<string, string[]>();
    for (const e of edges) next.set(e.taskId, [...(next.get(e.taskId) ?? []), e.dependsOnId]);
    const seen = new Set<string>([dependsOnId]);
    const queue = [dependsOnId];
    while (queue.length) {
      const current = queue.shift()!;
      if (current === task.id) throw new HttpError(409, 'This would create a circular dependency.');
      for (const n of next.get(current) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    try {
      await tx.taskDependency.create({ data: { taskId: task.id, dependsOnId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new HttpError(409, 'That dependency already exists.');
      throw err;
    }
    await recordActivity(tx, task.id, userId, 'dependency_added', { dependsOnId });
  });
  return { blockedBy: await blockedByRefs(task.id) };
};

export const removeDependency = async (userId: string, taskId: string, dependsOnId: string) => {
  const { actor, task } = await loadTaskContext(userId, taskId);
  assertTask(actor, 'task.update', task);
  if (!isUuid(dependsOnId)) throw new HttpError(404, 'Dependency not found.');
  const removed = await prisma.taskDependency.deleteMany({ where: { taskId: task.id, dependsOnId } });
  if (removed.count === 0) throw new HttpError(404, 'Dependency not found.');
  await recordActivity(prisma, task.id, userId, 'dependency_removed', { dependsOnId });
  return { blockedBy: await blockedByRefs(task.id) };
};

const blockedByRefs = async (taskId: string) =>
  (await prisma.task.findMany({ where: { dependents: { some: { taskId } } }, select: taskRefSelect, orderBy: { number: 'asc' } })).map(taskRef);


// ---- attachments ---------------------------------------------------------------------

/**
 * Attaches the caller's own, not-yet-used upload to a task (bind-once, like
 * sending it in a message): the attachment then follows the task's project
 * visibility (lib/attachments loadVisibleAttachment).
 */
export const attachToTask = async (userId: string, taskId: string, body: Record<string, unknown> | undefined) => {
  const { actor, task } = await loadTaskContext(userId, taskId);
  assertTask(actor, 'task.update', task);
  const attachmentId = parseOptionalUuid(body?.attachmentId, 'The file');
  if (!attachmentId) throw new HttpError(400, 'Choose a file to attach.');
  const bound = await prisma.attachment.updateMany({
    where: { id: attachmentId, uploaderId: userId, messageId: null, taskId: null },
    data: { taskId: task.id },
  });
  if (bound.count !== 1) throw new HttpError(409, 'That file is not available to attach. Upload it again.');
  await recordActivity(prisma, task.id, userId, 'attachment_added', { attachmentId });
  return { attachments: await taskAttachments(task.id) };
};

/** Detaches a file; the orphan sweeper later deletes it from storage. */
export const detachFromTask = async (userId: string, taskId: string, attachmentId: string) => {
  const { actor, task } = await loadTaskContext(userId, taskId);
  assertTask(actor, 'task.update', task);
  if (!isUuid(attachmentId)) throw new HttpError(404, 'File not found.');
  const removed = await prisma.attachment.updateMany({ where: { id: attachmentId, taskId: task.id }, data: { taskId: null } });
  if (removed.count !== 1) throw new HttpError(404, 'File not found.');
  await recordActivity(prisma, task.id, userId, 'attachment_removed', { attachmentId });
  return { attachments: await taskAttachments(task.id) };
};

const taskAttachments = async (taskId: string) =>
  (await prisma.attachment.findMany({ where: { taskId }, select: { id: true, originalName: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' } })).map((a) => ({
    id: a.id,
    url: attachmentPath(a.id),
    name: a.originalName,
    type: a.mimeType,
    size: a.size,
  }));

// ---- cross-project views -----------------------------------------------------------------

const DUE_SOON_DAYS = 7;
/** T.38: status groups of the member and Team Lead views. */
export const TODO_STATUSES: TaskStatus[] = ['BACKLOG', 'TODO', 'BLOCKED'];
export const IN_PROGRESS_STATUSES: TaskStatus[] = ['IN_PROGRESS', 'IN_REVIEW'];

export const myTasks = async (userId: string, workspaceId: string, query: Record<string, unknown>) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const workspace = await loadWorkspaceActor(userId, workspaceId);
  if (workspace.workspaceRole === null) throw new HttpError(404, 'Workspace not found.');
  const projects = visibleProjectsWhere(workspace);
  const now = new Date();
  const soon = new Date(now.getTime() + DUE_SOON_DAYS * 86_400_000);
  const open = { notIn: CLOSED_STATUSES };
  const views: Record<string, Prisma.TaskWhereInput> = {
    assigned: { assigneeId: userId, status: open },
    created: { creatorId: userId, assigneeId: { not: userId }, status: open },
    overdue: { assigneeId: userId, status: open, dueDate: { lt: now } },
    'due-soon': { assigneeId: userId, status: open, dueDate: { gte: now, lte: soon } },
    completed: { OR: [{ assigneeId: userId }, { creatorId: userId }], status: 'DONE' },
    // T.38: a member's own work by stage.
    todo: { assigneeId: userId, status: { in: TODO_STATUSES } },
    'in-progress': { assigneeId: userId, status: { in: IN_PROGRESS_STATUSES } },
    done: { assigneeId: userId, status: 'DONE' },
  };
  const view = typeof query.view === 'string' && query.view in views ? query.view : 'assigned';
  // Tasks of projects the caller can see (minus other people's private
  // assignments), plus — T.38 — their own private assignments wherever they live.
  const base: Prisma.TaskWhereInput = {
    workspaceId,
    project: { archivedAt: null },
    OR: [
      { project: projects, ...(canManageWorkspace(workspace) ? {} : privateAssignmentFilter(userId)) },
      { assigneeOnly: true, assigneeId: userId },
      { assigneeOnly: true, creatorId: userId },
    ],
  };
  const where = (v: string): Prisma.TaskWhereInput => ({ AND: [base, views[v]] });
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
  const cursor = typeof query.cursor === 'string' && isUuid(query.cursor) ? query.cursor : null;
  const orderBy: Prisma.TaskOrderByWithRelationInput[] =
    view === 'completed' || view === 'done' ? [{ completedAt: 'desc' }, { id: 'asc' }] : [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'asc' }, { id: 'asc' }];

  const countViews = ['assigned', 'created', 'overdue', 'due-soon', 'completed', 'todo', 'in-progress', 'done'];
  const [rows, ...counts] = await Promise.all([
    prisma.task.findMany({ where: where(view), select: taskSelect, orderBy, take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
    ...countViews.map((v) => prisma.task.count({ where: where(v) })),
  ]);
  const page = rows.slice(0, limit);
  const [assigned, created, overdue, dueSoon, completed, todo, inProgress, done] = counts;
  return {
    tasks: page.map((r) => taskView(r, { withProject: true, now: now.getTime() })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    counts: { assigned, created, overdue, dueSoon, completed, todo, inProgress, done },
  };
};

export const workload = async (userId: string, workspaceId: string, query: Record<string, unknown>) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const workspace = await loadWorkspaceActor(userId, workspaceId);
  if (workspace.workspaceRole === null && !canTaskWorkspaceManager(workspace)) throw new HttpError(404, 'Workspace not found.');
  let projectFilter: Prisma.ProjectWhereInput = { ...visibleProjectsWhere(workspace), archivedAt: null };
  if (query.projectId !== undefined) {
    const actor = await loadProjectActor(userId, query.projectId);
    assertProject(actor, 'project.view');
    if (actor.workspaceId !== workspaceId) throw new HttpError(404, 'Project not found.');
    projectFilter = { id: actor.projectId };
  }
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const tasks = await prisma.task.findMany({
    where: {
      workspaceId,
      project: projectFilter,
      OR: [{ status: { notIn: CLOSED_STATUSES } }, { status: 'DONE', completedAt: { gte: monthAgo } }],
      // T.38: other people's private assignments are not counted for non-leads.
      ...(workspace.workspaceRole !== null && canManageWorkspace(workspace) ? {} : { AND: [privateAssignmentFilter(userId)] }),
    },
    select: { assigneeId: true, status: true, dueDate: true, estimateHours: true, completedAt: true },
    take: 20_000,
  });
  const people = new Map<string, { open: number; inProgress: number; overdue: number; dueThisWeek: number; estimateHours: number; completedLast30: number }>();
  const unassigned = { open: 0, overdue: 0 };
  for (const t of tasks) {
    const closed = isClosed(t.status);
    const overdue = !closed && !!t.dueDate && t.dueDate < now;
    if (!t.assigneeId) {
      if (!closed) unassigned.open++;
      if (overdue) unassigned.overdue++;
      continue;
    }
    const p = people.get(t.assigneeId) ?? { open: 0, inProgress: 0, overdue: 0, dueThisWeek: 0, estimateHours: 0, completedLast30: 0 };
    if (!closed) {
      p.open++;
      p.estimateHours += t.estimateHours ?? 0;
      if (t.status === 'IN_PROGRESS' || t.status === 'IN_REVIEW') p.inProgress++;
      if (t.dueDate && t.dueDate >= now && t.dueDate <= weekEnd) p.dueThisWeek++;
    }
    if (overdue) p.overdue++;
    if (t.status === 'DONE') p.completedLast30++;
    people.set(t.assigneeId, p);
  }
  const users = await prisma.user.findMany({ where: { id: { in: [...people.keys()] } }, select: userRefSelect });
  const byId = new Map(users.map((u) => [u.id, userRef(u)!]));
  return {
    people: [...people.entries()]
      .filter(([id]) => byId.has(id))
      .map(([id, p]) => ({ user: byId.get(id)!, ...p, estimateHours: Math.round(p.estimateHours * 10) / 10 }))
      .sort((a, b) => b.open - a.open || a.user.username.localeCompare(b.user.username)),
    unassigned,
  };
};

const canTaskWorkspaceManager = (workspace: Awaited<ReturnType<typeof loadWorkspaceActor>>) => workspace.organizationRole === 'OWNER' || workspace.organizationRole === 'ADMIN';

export const projectReport = async (userId: string, projectId: string) => {
  const actor = await loadProjectActor(userId, projectId);
  assertProject(actor, 'project.view');
  const now = new Date();
  const eightWeeksAgo = startOfWeek(new Date(now.getTime() - 7 * 7 * 86_400_000));
  const tasks = await prisma.task.findMany({
    // T.38: other people's private assignments are not counted for non-leads.
    where: { projectId: actor.projectId, ...(isProjectLead(actor) ? {} : privateAssignmentFilter(userId)) },
    select: { status: true, priority: true, dueDate: true, assigneeId: true, completedAt: true },
    take: 50_000,
  });
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<TaskPriority, number>;
  const assignees = new Map<string | null, { open: number; done: number }>();
  const weeks = Array.from({ length: 8 }, (_, i) => ({ weekStart: new Date(eightWeeksAgo.getTime() + i * 7 * 86_400_000), count: 0 }));
  let overdue = 0;
  let unassigned = 0;
  for (const t of tasks) {
    byStatus[t.status]++;
    byPriority[t.priority]++;
    const closed = isClosed(t.status);
    if (!closed && t.dueDate && t.dueDate < now) overdue++;
    if (!closed && !t.assigneeId) unassigned++;
    const a = assignees.get(t.assigneeId) ?? { open: 0, done: 0 };
    if (!closed) a.open++;
    if (t.status === 'DONE') a.done++;
    assignees.set(t.assigneeId, a);
    if (t.status === 'DONE' && t.completedAt && t.completedAt >= eightWeeksAgo) {
      const index = Math.floor((t.completedAt.getTime() - eightWeeksAgo.getTime()) / (7 * 86_400_000));
      if (weeks[index]) weeks[index].count++;
    }
  }
  const users = await prisma.user.findMany({ where: { id: { in: [...assignees.keys()].filter((id): id is string => !!id) } }, select: userRefSelect });
  const byId = new Map(users.map((u) => [u.id, userRef(u)!]));
  const done = byStatus.DONE;
  const cancelled = byStatus.CANCELLED;
  const countable = tasks.length - cancelled;
  return {
    totals: { all: tasks.length, open: tasks.length - done - cancelled, done, cancelled, overdue, unassigned, completionPercent: countable > 0 ? Math.round((done / countable) * 100) : 0 },
    byStatus,
    byPriority,
    completedByWeek: weeks,
    byAssignee: [...assignees.entries()]
      .map(([id, v]) => ({ user: id ? byId.get(id) ?? null : null, ...v }))
      .filter((a) => a.user !== null || a.open + a.done > 0)
      .sort((a, b) => b.open - a.open),
  };
};

const startOfWeek = (date: Date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - day * 86_400_000);
};

// ---- notifications ---------------------------------------------------------------------

export const listWorkNotifications = async (userId: string, workspaceId: string, query: Record<string, unknown>) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 50);
  const where: Prisma.WorkNotificationWhereInput = { userId, workspaceId, ...(query.unread === '1' ? { readAt: null } : {}) };
  const [rows, unreadCount] = await Promise.all([
    prisma.workNotification.findMany({ where, select: workNotificationSelect, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.workNotification.count({ where: { userId, workspaceId, readAt: null } }),
  ]);
  return { notifications: rows.map(workNotificationView), unreadCount };
};

export const markWorkNotificationsRead = async (userId: string, body: Record<string, unknown> | undefined) => {
  const workspaceId = body?.workspaceId;
  if (!isUuid(workspaceId)) throw new HttpError(400, 'workspaceId is required.');
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((id): id is string => isUuid(id)).slice(0, 200) : null;
  if (!ids && body?.all !== true) throw new HttpError(400, 'Pass ids or all: true.');
  const result = await prisma.workNotification.updateMany({
    where: { userId, workspaceId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
  return { updated: result.count };
};

/**
 * Overdue reminders (run periodically). Idempotent and safe on several
 * instances at once: each task is claimed with a conditional update
 * (overdueNotifiedAt IS NULL), so exactly one instance notifies.
 */
export const runOverdueReminders = async (now = new Date()) => {
  const candidates = await prisma.task.findMany({
    where: { dueDate: { lt: now }, status: { notIn: CLOSED_STATUSES }, overdueNotifiedAt: null, assigneeId: { not: null }, project: { archivedAt: null } },
    select: { id: true },
    take: 500,
  });
  const sent: Awaited<ReturnType<typeof createWorkNotifications>> = [];
  for (const { id } of candidates) {
    const claimed = await prisma.task.updateMany({ where: { id, overdueNotifiedAt: null }, data: { overdueNotifiedAt: now } });
    if (claimed.count !== 1) continue;
    const view = await loadTaskView(id);
    if (!view.assignee) continue;
    sent.push(
      ...(await createWorkNotifications([
        { userId: view.assignee.id, workspaceId: view.workspaceId, projectId: view.projectId, taskId: id, actorId: null, type: 'task_overdue', title: `${view.identifier} ${view.title}`, body: 'This task is past its due date.' },
      ]))
    );
  }
  return sent;
};

export { isProjectLead };

/** A task's current view (for re-broadcasting a parent or after a comment). */
export const getTaskView = (taskId: string) => loadTaskView(taskId);
