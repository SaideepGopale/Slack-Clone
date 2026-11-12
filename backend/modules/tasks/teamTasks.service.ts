import { Prisma, TaskStatus } from '@prisma/client';
import { HttpError } from '../../lib/httpError';
import { isUuid } from '../../lib/messageInput';
import { assertTask, canManageWorkspace, loadProjectActor, loadWorkspaceActor } from '../../lib/policy';
import { prisma } from '../../lib/prisma';
import {
  assertWorkspaceAssignable,
  createWorkNotifications,
  csv,
  IN_PROGRESS_STATUSES,
  parseDate,
  parseDescription,
  parsePriority,
  parseStatus,
  parseTitle,
  POSITION_GAP,
  recordActivity,
  TODO_STATUSES,
} from './tasks.service';
import { CLOSED_STATUSES, projectKey, taskSelect, taskView, userRef, userRefSelect } from './tasks.views';

/**
 * T.38 — the Team Lead dashboard: a workspace's tasks, per-member progress,
 * and quick assignment. Built on the T.33 task system (same Task rows,
 * statuses, comments, activity, notifications and socket events).
 *
 *  - Lead = a member of the workspace who manages it (owner or admin, or an
 *    organization owner/admin who is also a member) — lib/policy
 *    canManageWorkspace. Not a member: 404. Member but not a lead: 403.
 *  - Tasks created here are PRIVATE ASSIGNMENTS (Task.assigneeOnly): visible
 *    only to their assignee, their creator and the leads (lib/policy
 *    canPrivateTask). They live in the workspace's "Team tasks" project
 *    (created on first use, private) unless the lead picks another project.
 *  - Nothing in the request decides who is acting, which workspace it is,
 *    the status, the creator or the visibility: only title, description,
 *    assignee, priority, due date and an optional project are read.
 */

const TEAM_PROJECT_NAME = 'Team tasks';
const TEAM_PROJECT_KEY = 'TEAM';
const TEAM_PROJECT_DESCRIPTION = 'Private task assignments from the Team Lead dashboard. Each task is visible only to its assignee and the workspace leads.';
const LIST_DEFAULT = 50;
const LIST_MAX = 100;

/** The caller must lead this workspace. */
export const loadTeamLead = async (userId: string, workspaceId: unknown) => {
  if (!isUuid(workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const workspace = await loadWorkspaceActor(userId, workspaceId);
  if (workspace.workspaceRole === null) throw new HttpError(404, 'Workspace not found.');
  if (workspace.isDefaultWorkspace) throw new HttpError(403, 'Team tasks are not available in SmartConnect Collab.');
  if (!canManageWorkspace(workspace)) throw new HttpError(403, "Only this workspace's Team Lead can manage team tasks.");
  return workspace;
};

/** Every task of the workspace that a lead manages here (archived projects excluded). */
const workspaceTasks = (workspaceId: string): Prisma.TaskWhereInput => ({ workspaceId, project: { archivedAt: null } });

/** The workspace's "Team tasks" project (private), created on first use — once, even under concurrent requests. */
const ensureTeamTasksProject = (workspaceId: string, leadId: string) =>
  prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ teamTasksProjectId: string | null }[]>`SELECT "teamTasksProjectId" FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
    if (row?.teamTasksProjectId) {
      const existing = await tx.project.findUnique({ where: { id: row.teamTasksProjectId }, select: { id: true, archivedAt: true } });
      if (existing && !existing.archivedAt) return existing.id;
    }
    const keyTaken = await tx.project.findFirst({ where: { workspaceId, key: TEAM_PROJECT_KEY, archivedAt: null }, select: { id: true } });
    const project = await tx.project.create({
      data: {
        workspaceId,
        name: TEAM_PROJECT_NAME,
        description: TEAM_PROJECT_DESCRIPTION,
        visibility: 'PRIVATE',
        createdById: leadId,
        key: keyTaken ? null : TEAM_PROJECT_KEY,
        members: { create: { userId: leadId, role: 'OWNER' } },
      },
      select: { id: true },
    });
    await tx.workspace.update({ where: { id: workspaceId }, data: { teamTasksProjectId: project.id } });
    return project.id;
  });

// ---- options ---------------------------------------------------------------------------

const activeMembers = async (workspaceId: string) => {
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId, user: { status: 'ACTIVE' } },
    select: { role: true, user: { select: userRefSelect } },
  });
  return rows
    .map((r) => ({ ...userRef(r.user)!, workspaceRole: r.role }))
    .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username));
};

/** GET /api/workspaces/:id/team-tasks/options — who can be assigned, and the projects a task may be filed under. */
export const teamTaskOptions = async (userId: string, workspaceId: string) => {
  await loadTeamLead(userId, workspaceId);
  const [members, projects, workspace] = await Promise.all([
    activeMembers(workspaceId),
    prisma.project.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, key: true }, orderBy: { name: 'asc' } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { teamTasksProjectId: true } }),
  ]);
  return {
    members,
    projects: projects.filter((p) => p.id !== workspace.teamTasksProjectId).map((p) => ({ id: p.id, name: p.name, key: projectKey(p) })),
  };
};

// ---- summary ---------------------------------------------------------------------------

const isTodo = (s: TaskStatus) => TODO_STATUSES.includes(s);
const isInProgress = (s: TaskStatus) => IN_PROGRESS_STATUSES.includes(s);

/** GET /api/workspaces/:id/team-tasks/summary — totals and per-member progress. */
export const teamSummary = async (userId: string, workspaceId: string) => {
  await loadTeamLead(userId, workspaceId);
  const now = new Date();
  const [byStatus, overdueRows, members] = await Promise.all([
    prisma.task.groupBy({ by: ['assigneeId', 'status'], where: workspaceTasks(workspaceId), _count: { _all: true } }),
    prisma.task.groupBy({ by: ['assigneeId'], where: { ...workspaceTasks(workspaceId), status: { notIn: CLOSED_STATUSES }, dueDate: { lt: now } }, _count: { _all: true } }),
    activeMembers(workspaceId),
  ]);

  const totals = { total: 0, todo: 0, inProgress: 0, completed: 0, overdue: 0, cancelled: 0, unassigned: 0 };
  const per = new Map<string, { total: number; pending: number; inProgress: number; completed: number; overdue: number }>();
  const forMember = (id: string) => {
    let p = per.get(id);
    if (!p) per.set(id, (p = { total: 0, pending: 0, inProgress: 0, completed: 0, overdue: 0 }));
    return p;
  };
  for (const row of byStatus) {
    const n = row._count._all;
    if (row.status === 'CANCELLED') {
      totals.cancelled += n;
      continue;
    }
    totals.total += n;
    if (isTodo(row.status)) totals.todo += n;
    if (isInProgress(row.status)) totals.inProgress += n;
    if (row.status === 'DONE') totals.completed += n;
    if (!row.assigneeId) {
      if (row.status !== 'DONE') totals.unassigned += n;
      continue;
    }
    const p = forMember(row.assigneeId);
    p.total += n;
    if (isTodo(row.status)) p.pending += n;
    if (isInProgress(row.status)) p.inProgress += n;
    if (row.status === 'DONE') p.completed += n;
  }
  for (const row of overdueRows) {
    totals.overdue += row._count._all;
    if (row.assigneeId) forMember(row.assigneeId).overdue += row._count._all;
  }
  return {
    totals,
    members: members.map((m) => {
      const p = per.get(m.id) ?? { total: 0, pending: 0, inProgress: 0, completed: 0, overdue: 0 };
      return { user: { id: m.id, username: m.username, displayName: m.displayName }, workspaceRole: m.workspaceRole, ...p, completionRate: p.total ? Math.round((p.completed * 100) / p.total) : 0 };
    }),
    generatedAt: now,
  };
};

// ---- table -----------------------------------------------------------------------------

const STATUS_GROUPS: Record<string, TaskStatus[]> = {
  todo: TODO_STATUSES,
  in_progress: IN_PROGRESS_STATUSES,
  completed: ['DONE'],
  cancelled: ['CANCELLED'],
};
const parseStatusOrGroup = (value: unknown): TaskStatus[] => (typeof value === 'string' && STATUS_GROUPS[value.toLowerCase()] ? STATUS_GROUPS[value.toLowerCase()] : [parseStatus(value)]);

/** GET /api/workspaces/:id/team-tasks — every task of the workspace, filtered, newest first. */
export const listTeamTasks = async (userId: string, workspaceId: string, query: Record<string, unknown>) => {
  await loadTeamLead(userId, workspaceId);
  const now = new Date();
  const filters: Prisma.TaskWhereInput[] = [workspaceTasks(workspaceId)];

  if (query.assigneeId === 'none') filters.push({ assigneeId: null });
  else if (query.assigneeId !== undefined && query.assigneeId !== '') {
    if (!isUuid(query.assigneeId)) throw new HttpError(400, 'Member is invalid.');
    filters.push({ assigneeId: query.assigneeId });
  }
  const statuses = csv(query.status, (v) => v as string)?.flatMap(parseStatusOrGroup);
  if (statuses?.length) filters.push({ status: { in: statuses } });
  const priorities = csv(query.priority, parsePriority);
  if (priorities?.length) filters.push({ priority: { in: priorities } });

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday.getTime() + 86_400_000 - 1);
  switch (query.due) {
    case undefined:
    case '':
      break;
    case 'overdue':
      filters.push({ status: { notIn: CLOSED_STATUSES }, dueDate: { lt: now } });
      break;
    case 'today':
      filters.push({ dueDate: { gte: startOfToday, lte: endOfToday } });
      break;
    case 'week':
      filters.push({ dueDate: { gte: startOfToday, lte: new Date(startOfToday.getTime() + 7 * 86_400_000) } });
      break;
    case 'none':
      filters.push({ dueDate: null });
      break;
    default:
      throw new HttpError(400, 'Due date filter must be overdue, today, week or none.');
  }
  if (query.overdue === '1' || query.overdue === 'true') filters.push({ status: { notIn: CLOSED_STATUSES }, dueDate: { lt: now } });
  if (typeof query.q === 'string' && query.q.trim()) {
    const q = query.q.trim().slice(0, 100);
    const number = /^[A-Za-z0-9]{1,6}-(\d+)$/.exec(q)?.[1];
    filters.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }, ...(number ? [{ number: Number(number) }] : [])] });
  }

  const where: Prisma.TaskWhereInput = { AND: filters };
  const limit = Math.min(Math.max(Number(query.limit) || LIST_DEFAULT, 1), LIST_MAX);
  const cursor = typeof query.cursor === 'string' && isUuid(query.cursor) ? query.cursor : null;
  const [rows, total] = await Promise.all([
    prisma.task.findMany({ where, select: taskSelect, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
    prisma.task.count({ where }),
  ]);
  const page = rows.slice(0, limit);
  return { tasks: page.map((r) => taskView(r, { withProject: true, now: now.getTime() })), nextCursor: rows.length > limit ? page[page.length - 1].id : null, total };
};

// ---- create ----------------------------------------------------------------------------

/** POST /api/workspaces/:id/team-tasks { title, description?, assigneeId, priority?, dueDate?, projectId? } */
export const createTeamTask = async (userId: string, workspaceId: string, body: Record<string, unknown> | undefined) => {
  await loadTeamLead(userId, workspaceId);
  const title = parseTitle(body?.title);
  const description = parseDescription(body?.description);
  const priority = body?.priority !== undefined && body.priority !== '' ? parsePriority(body.priority) : 'MEDIUM';
  const dueDate = body?.dueDate !== undefined && body.dueDate !== '' ? parseDate(body.dueDate, 'Due date') : null;
  const assigneeId = body?.assigneeId;
  if (!isUuid(assigneeId)) throw new HttpError(400, 'Choose who this task is assigned to.');
  await assertWorkspaceAssignable(workspaceId, assigneeId);

  let projectId: string;
  if (body?.projectId !== undefined && body.projectId !== null && body.projectId !== '') {
    const actor = await loadProjectActor(userId, body.projectId); // 404 when unknown
    if (actor.workspaceId !== workspaceId) throw new HttpError(404, 'Project not found.');
    assertTask(actor, 'task.assignOthers'); // the caller leads that project (409 when archived)
    projectId = actor.projectId;
  } else {
    projectId = await ensureTeamTasksProject(workspaceId, userId);
  }

  const created = await prisma.$transaction(async (tx) => {
    const project = await tx.project.update({ where: { id: projectId }, data: { taskSequence: { increment: 1 } }, select: { taskSequence: true, archivedAt: true } });
    if (project.archivedAt) throw new HttpError(409, 'This project is archived. Restore it first.');
    const last = await tx.task.findFirst({ where: { projectId, status: 'TODO', parentId: null }, orderBy: { position: 'desc' }, select: { position: true } });
    const task = await tx.task.create({
      data: {
        projectId,
        workspaceId,
        number: project.taskSequence,
        title,
        description,
        status: 'TODO',
        priority,
        creatorId: userId,
        assigneeId,
        dueDate,
        position: (last?.position ?? 0) + POSITION_GAP,
        assigneeOnly: true,
      },
      select: { id: true },
    });
    await recordActivity(tx, task.id, userId, 'created', { status: 'TODO', assigneeId });
    return task;
  });

  const row = await prisma.task.findUniqueOrThrow({ where: { id: created.id }, select: taskSelect });
  const view = taskView(row, { withProject: true });
  const notifications =
    assigneeId === userId
      ? []
      : await createWorkNotifications([
          { userId: assigneeId, workspaceId, projectId, taskId: view.id, actorId: userId, type: 'task_assigned', title: `${view.identifier} ${view.title}`, body: 'You were assigned a new task.' },
        ]);
  return { task: view, notifications };
};
