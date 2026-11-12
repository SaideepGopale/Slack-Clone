import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { runOverdueReminders } from '../modules/tasks/tasks.service';
import { addToWorkspace, createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser } from './helpers';

/**
 * T.33 — project & task management over the real API and a disposable
 * database: identifiers, permissions (lead / member / outsider), IDOR and
 * tenant isolation, status and review rules, dependencies (blocking, cycles,
 * races), board moves, comments, notifications, cross-project views,
 * reports, sharing to chat and the overdue reminder job.
 */
const api = (user: TestUser) => ({
  get: (path: string) => request(app).get(path).set(authHeader(user.token)),
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(user.token)).send(body),
  patch: (path: string, body: object) => request(app).patch(path).set(authHeader(user.token)).send(body),
  delete: (path: string) => request(app).delete(path).set(authHeader(user.token)),
});

/** Workspace (lead = owner), a project, a project member and a workspace-only member. */
const setup = async (projectBody: object = {}) => {
  const lead = await createAndLoginUser();
  const { workspaceId, generalChannelId } = await createWorkspace(lead);
  const member = await createAndLoginUser();
  const bystander = await createAndLoginUser();
  await addToWorkspace(member, workspaceId, [generalChannelId]);
  await addToWorkspace(bystander, workspaceId, [generalChannelId]);
  const project = await api(lead).post(`/api/workspaces/${workspaceId}/projects`, { name: 'Website Relaunch', key: 'web', ...projectBody });
  expect(project.status).toBe(201);
  const projectId = project.body.id as string;
  expect((await api(lead).post(`/api/projects/${projectId}/members`, { userId: member.user.id })).status).toBe(201);
  return { lead, member, bystander, workspaceId, generalChannelId, projectId };
};

const newTask = async (user: TestUser, projectId: string, body: object = {}) => {
  const res = await api(user).post(`/api/projects/${projectId}/tasks`, { title: 'Write copy', ...body });
  expect(res.status).toBe(201);
  return res.body.task as { id: string; identifier: string; number: number; status: string; position: number };
};

describe('tasks: identifiers and creation', () => {
  it('numbers tasks per project with the project key, even under concurrent creation', async () => {
    const w = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => api(w.lead).post(`/api/projects/${w.projectId}/tasks`, { title: `Task ${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.task.number).sort((a: number, b: number) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(results.map((r) => r.body.task.identifier)).toContain('WEB-10');
  });

  it('validates input', async () => {
    const w = await setup();
    const bad = [
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: 'ok', status: 'NOPE' },
      { title: 'ok', priority: 'SOON' },
      { title: 'ok', dueDate: 'not-a-date' },
      { title: 'ok', startDate: '2026-12-10', dueDate: '2026-12-01' },
      { title: 'ok', estimateHours: -1 },
      { title: 'ok', labels: ['x'.repeat(31)] },
      { title: 'ok', labels: Array.from({ length: 11 }, (_, i) => `l${i}`) },
    ];
    for (const body of bad) expect((await api(w.lead).post(`/api/projects/${w.projectId}/tasks`, body)).status).toBe(400);
  });

  it('supports one level of subtasks, counted on the parent and deleted with it', async () => {
    const w = await setup();
    const parent = await newTask(w.lead, w.projectId, { title: 'Parent' });
    const child = await newTask(w.lead, w.projectId, { title: 'Child', parentId: parent.id });
    expect((await api(w.lead).post(`/api/projects/${w.projectId}/tasks`, { title: 'Grandchild', parentId: child.id })).status).toBe(400);
    const detail = await api(w.lead).get(`/api/tasks/${parent.id}`);
    expect(detail.body.subtaskCount).toBe(1);
    expect(detail.body.subtasks.map((s: { id: string }) => s.id)).toEqual([child.id]);
    // Board lists only top-level tasks by default.
    const list = await api(w.lead).get(`/api/projects/${w.projectId}/tasks`);
    expect(list.body.tasks.map((t: { id: string }) => t.id)).toEqual([parent.id]);
    expect((await api(w.lead).delete(`/api/tasks/${parent.id}`)).status).toBe(200);
    expect(await prisma.task.count({ where: { id: { in: [parent.id, child.id] } } })).toBe(0);
  });
});

describe('tasks: permissions, IDOR and tenant isolation', () => {
  it('private projects are invisible to non-members (404 everywhere, never 403)', async () => {
    const w = await setup({ visibility: 'PRIVATE' });
    const task = await newTask(w.lead, w.projectId);
    const outsider = await createAndLoginUser();
    for (const user of [w.bystander, outsider]) {
      expect((await api(user).get(`/api/projects/${w.projectId}/tasks`)).status).toBe(404);
      expect((await api(user).post(`/api/projects/${w.projectId}/tasks`, { title: 'x' })).status).toBe(404);
      expect((await api(user).get(`/api/tasks/${task.id}`)).status).toBe(404);
      expect((await api(user).patch(`/api/tasks/${task.id}`, { title: 'pwned' })).status).toBe(404);
      expect((await api(user).delete(`/api/tasks/${task.id}`)).status).toBe(404);
      expect((await api(user).post(`/api/tasks/${task.id}/comments`, { body: 'hi' })).status).toBe(404);
      expect((await api(user).get(`/api/projects/${w.projectId}/report`)).status).toBe(404);
    }
    expect((await prisma.task.findUnique({ where: { id: task.id } }))?.title).toBe('Write copy');
  });

  it('public projects: workspace members can read but only project members create', async () => {
    const w = await setup();
    const task = await newTask(w.member, w.projectId);
    expect((await api(w.bystander).get(`/api/tasks/${task.id}`)).status).toBe(200);
    expect((await api(w.bystander).post(`/api/projects/${w.projectId}/tasks`, { title: 'x' })).status).toBe(403);
    expect((await api(w.bystander).patch(`/api/tasks/${task.id}`, { title: 'x' })).status).toBe(403);
    expect((await api(w.bystander).post(`/api/tasks/${task.id}/comments`, { body: 'x' })).status).toBe(403);
    const outsider = await createAndLoginUser();
    expect((await api(outsider).get(`/api/tasks/${task.id}`)).status).toBe(404);
  });

  it('assignment: members assign only themselves; leads assign project members only', async () => {
    const w = await setup();
    const task = await newTask(w.member, w.projectId);
    expect((await api(w.member).patch(`/api/tasks/${task.id}`, { assigneeId: w.lead.user.id })).status).toBe(403);
    expect((await api(w.member).patch(`/api/tasks/${task.id}`, { assigneeId: w.member.user.id })).status).toBe(200);
    expect((await api(w.lead).patch(`/api/tasks/${task.id}`, { assigneeId: w.bystander.user.id })).status).toBe(400); // not a project member
    const stranger = await createAndLoginUser();
    expect((await api(w.lead).patch(`/api/tasks/${task.id}`, { assigneeId: stranger.user.id })).status).toBe(400);
    expect((await api(w.lead).patch(`/api/tasks/${task.id}`, { assigneeId: w.lead.user.id })).status).toBe(200);
    // Creating with someone else as assignee follows the same rule.
    expect((await api(w.member).post(`/api/projects/${w.projectId}/tasks`, { title: 'x', assigneeId: w.lead.user.id })).status).toBe(403);
    // The assignee is notified (not the lead who assigned themself).
    await api(w.lead).patch(`/api/tasks/${task.id}`, { assigneeId: w.member.user.id });
    expect(await prisma.workNotification.count({ where: { userId: w.member.user.id, taskId: task.id, type: 'task_assigned' } })).toBe(1);
  });

  it('status: only lead or assignee; with review required only a lead completes', async () => {
    const w = await setup({ requireReview: true });
    const task = await newTask(w.lead, w.projectId, { assigneeId: w.member.user.id });
    const other = await createAndLoginUser();
    await addToWorkspace(other, w.workspaceId);
    await api(w.lead).post(`/api/projects/${w.projectId}/members`, { userId: other.user.id });
    expect((await api(other).patch(`/api/tasks/${task.id}`, { status: 'IN_PROGRESS' })).status).toBe(403);
    expect((await api(w.member).patch(`/api/tasks/${task.id}`, { status: 'IN_REVIEW' })).status).toBe(200);
    const done = await api(w.member).patch(`/api/tasks/${task.id}`, { status: 'DONE' });
    expect(done.status).toBe(403);
    expect(done.body.error).toMatch(/requires review/);
    const byLead = await api(w.lead).patch(`/api/tasks/${task.id}`, { status: 'DONE' });
    expect(byLead.status).toBe(200);
    expect(byLead.body.task.completedAt).not.toBeNull();
    const detail = await api(w.member).get(`/api/tasks/${task.id}`);
    expect(detail.body.capabilities).toMatchObject({ changeStatus: true, complete: false, assignOthers: false, delete: false });
    expect(detail.body.activity.map((a: { type: string }) => a.type)).toEqual(expect.arrayContaining(['created', 'status']));
  });

  it('a task cannot be moved into another project or reached through another workspace', async () => {
    const a = await setup();
    const b = await setup();
    const taskA = await newTask(a.lead, a.projectId);
    const taskB = await newTask(b.lead, b.projectId);
    // Lead of workspace B cannot touch A's task by id.
    expect((await api(b.lead).get(`/api/tasks/${taskA.id}`)).status).toBe(404);
    expect((await api(b.lead).post(`/api/tasks/${taskA.id}/move`, { status: 'DONE' })).status).toBe(404);
    // Neighbours / parents / dependencies from another project are refused.
    expect((await api(a.lead).post(`/api/tasks/${taskA.id}/move`, { status: 'TODO', prevId: taskB.id })).status).toBe(400);
    expect((await api(a.lead).post(`/api/projects/${a.projectId}/tasks`, { title: 'x', parentId: taskB.id })).status).toBe(400);
    expect((await api(a.lead).post(`/api/tasks/${taskA.id}/dependencies`, { dependsOnId: taskB.id })).status).toBe(400);
  });

  it('archived projects are read-only', async () => {
    const w = await setup();
    const task = await newTask(w.lead, w.projectId);
    expect((await api(w.lead).post(`/api/projects/${w.projectId}/archive`)).status).toBe(200);
    expect((await api(w.lead).get(`/api/tasks/${task.id}`)).status).toBe(200);
    expect((await api(w.lead).patch(`/api/tasks/${task.id}`, { title: 'x' })).status).toBe(409);
    expect((await api(w.lead).post(`/api/projects/${w.projectId}/tasks`, { title: 'x' })).status).toBe(409);
    expect((await api(w.lead).post(`/api/tasks/${task.id}/comments`, { body: 'x' })).status).toBe(409);
  });
});

describe('tasks: dependencies', () => {
  it('open blockers prevent completion; completing them unblocks', async () => {
    const w = await setup();
    const blocker = await newTask(w.lead, w.projectId, { title: 'API' });
    const blocked = await newTask(w.lead, w.projectId, { title: 'UI' });
    expect((await api(w.lead).post(`/api/tasks/${blocked.id}/dependencies`, { dependsOnId: blocker.id })).status).toBe(201);
    const refused = await api(w.lead).post(`/api/tasks/${blocked.id}/move`, { status: 'DONE' });
    expect(refused.status).toBe(409);
    expect(refused.body.blockers.map((b: { id: string }) => b.id)).toEqual([blocker.id]);
    expect((await api(w.lead).patch(`/api/tasks/${blocked.id}`, { status: 'DONE' })).status).toBe(409);
    expect((await api(w.lead).get(`/api/tasks/${blocked.id}`)).body.openBlockerCount).toBe(1);
    await api(w.lead).patch(`/api/tasks/${blocker.id}`, { status: 'DONE' });
    expect((await api(w.lead).patch(`/api/tasks/${blocked.id}`, { status: 'DONE' })).status).toBe(200);
  });

  it('refuses cycles, self-dependencies and duplicates', async () => {
    const w = await setup();
    const [a, b, c] = [await newTask(w.lead, w.projectId), await newTask(w.lead, w.projectId), await newTask(w.lead, w.projectId)];
    expect((await api(w.lead).post(`/api/tasks/${a.id}/dependencies`, { dependsOnId: b.id })).status).toBe(201);
    expect((await api(w.lead).post(`/api/tasks/${b.id}/dependencies`, { dependsOnId: c.id })).status).toBe(201);
    const cycle = await api(w.lead).post(`/api/tasks/${c.id}/dependencies`, { dependsOnId: a.id });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error).toMatch(/circular/);
    expect((await api(w.lead).post(`/api/tasks/${a.id}/dependencies`, { dependsOnId: a.id })).status).toBe(400);
    expect((await api(w.lead).post(`/api/tasks/${a.id}/dependencies`, { dependsOnId: b.id })).status).toBe(409);
    expect((await api(w.lead).delete(`/api/tasks/${a.id}/dependencies/${b.id}`)).body.blockedBy).toEqual([]);
  });

  it('two opposite dependencies added at the same moment cannot both succeed', async () => {
    const w = await setup();
    const a = await newTask(w.lead, w.projectId);
    const b = await newTask(w.lead, w.projectId);
    const [ab, ba] = await Promise.all([
      api(w.lead).post(`/api/tasks/${a.id}/dependencies`, { dependsOnId: b.id }),
      api(w.lead).post(`/api/tasks/${b.id}/dependencies`, { dependsOnId: a.id }),
    ]);
    expect([ab.status, ba.status].sort()).toEqual([201, 409]);
    expect(await prisma.taskDependency.count({ where: { taskId: { in: [a.id, b.id] } } })).toBe(1);
  });
});

describe('tasks: board moves', () => {
  it('places a card between its new neighbours and keeps column order', async () => {
    const w = await setup();
    const [t1, t2, t3] = [await newTask(w.lead, w.projectId, { title: '1' }), await newTask(w.lead, w.projectId, { title: '2' }), await newTask(w.lead, w.projectId, { title: '3' })];
    // Move 3 between 1 and 2.
    const moved = await api(w.lead).post(`/api/tasks/${t3.id}/move`, { status: 'TODO', prevId: t1.id, nextId: t2.id });
    expect(moved.status).toBe(200);
    const order = (await api(w.lead).get(`/api/projects/${w.projectId}/tasks?status=TODO`)).body.tasks.map((t: { title: string }) => t.title);
    expect(order).toEqual(['1', '3', '2']);
    // Into another column (top), and a stale neighbour is refused.
    expect((await api(w.lead).post(`/api/tasks/${t1.id}/move`, { status: 'IN_PROGRESS', nextId: null, prevId: null })).body.task.status).toBe('IN_PROGRESS');
    expect((await api(w.lead).post(`/api/tasks/${t2.id}/move`, { status: 'IN_PROGRESS', prevId: t3.id })).status).toBe(400);
  });

  it('renumbers a column when the gap between neighbours is exhausted', async () => {
    const w = await setup();
    const a = await newTask(w.lead, w.projectId, { title: 'a' });
    const b = await newTask(w.lead, w.projectId, { title: 'b' });
    const c = await newTask(w.lead, w.projectId, { title: 'c' });
    await prisma.task.update({ where: { id: a.id }, data: { position: 1 } });
    await prisma.task.update({ where: { id: b.id }, data: { position: 1 + 1e-9 } });
    expect((await api(w.lead).post(`/api/tasks/${c.id}/move`, { status: 'TODO', prevId: a.id, nextId: b.id })).status).toBe(200);
    const order = (await api(w.lead).get(`/api/projects/${w.projectId}/tasks?status=TODO`)).body.tasks.map((t: { title: string }) => t.title);
    expect(order).toEqual(['a', 'c', 'b']);
  });
});

describe('tasks: comments and notifications', () => {
  it('comments notify the assignee and creator; only authors edit; leads may delete', async () => {
    const w = await setup();
    const task = await newTask(w.member, w.projectId, { assigneeId: w.member.user.id });
    const comment = await api(w.lead).post(`/api/tasks/${task.id}/comments`, { body: 'Looks good' });
    expect(comment.status).toBe(201);
    const id = comment.body.comment.id;
    expect(await prisma.workNotification.count({ where: { userId: w.member.user.id, taskId: task.id, type: 'task_comment' } })).toBe(1);
    expect((await api(w.member).patch(`/api/task-comments/${id}`, { body: 'edited by someone else' })).status).toBe(403);
    expect((await api(w.lead).patch(`/api/task-comments/${id}`, { body: 'Looks great' })).body.comment.editedAt).not.toBeNull();
    const mine = await api(w.member).post(`/api/tasks/${task.id}/comments`, { body: 'Thanks' });
    expect((await api(w.lead).delete(`/api/task-comments/${mine.body.comment.id}`)).status).toBe(200);
    expect((await api(w.member).post(`/api/tasks/${task.id}/comments`, { body: '' })).status).toBe(400);

    const inbox = await api(w.member).get(`/api/workspaces/${w.workspaceId}/work-notifications`);
    expect(inbox.body.unreadCount).toBeGreaterThanOrEqual(1);
    const read = await api(w.member).post('/api/work-notifications/read', { workspaceId: w.workspaceId, all: true });
    expect(read.body.updated).toBe(inbox.body.unreadCount);
    // Nobody can read or clear someone else's inbox.
    expect((await api(w.lead).get(`/api/workspaces/${w.workspaceId}/work-notifications`)).body.notifications.every((n: { taskId: string }) => n.taskId !== null)).toBe(true);
  });
});

describe('tasks: cross-project views and reports', () => {
  it('my tasks: assigned / created / overdue / due soon / completed, limited to visible projects', async () => {
    const w = await setup();
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await newTask(w.lead, w.projectId, { title: 'late', assigneeId: w.member.user.id, dueDate: past });
    await newTask(w.lead, w.projectId, { title: 'soon', assigneeId: w.member.user.id, dueDate: soon });
    const mine = await newTask(w.member, w.projectId, { title: 'mine' });
    await api(w.member).patch(`/api/tasks/${mine.id}`, { assigneeId: w.member.user.id });
    await api(w.member).patch(`/api/tasks/${mine.id}`, { status: 'DONE' });

    const res = await api(w.member).get(`/api/workspaces/${w.workspaceId}/my-tasks?view=assigned`);
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ assigned: 2, overdue: 1, dueSoon: 1, completed: 1 });
    expect(res.body.tasks.map((t: { title: string }) => t.title)).toEqual(['late', 'soon']); // by due date
    expect(res.body.tasks[0]).toMatchObject({ overdue: true, project: { id: w.projectId, key: 'WEB' } });
    const created = await api(w.lead).get(`/api/workspaces/${w.workspaceId}/my-tasks?view=created`);
    expect(created.body.tasks.map((t: { title: string }) => t.title).sort()).toEqual(['late', 'soon']);

    // Private project + removal from it: the tasks disappear from "my tasks".
    await api(w.lead).patch(`/api/projects/${w.projectId}`, { visibility: 'PRIVATE' });
    expect((await api(w.lead).delete(`/api/projects/${w.projectId}/members/${w.member.user.id}`)).status).toBe(200);
    expect((await api(w.member).get(`/api/workspaces/${w.workspaceId}/my-tasks?view=assigned`)).body.tasks).toEqual([]);
    // Outsiders get nothing at all.
    const outsider = await createAndLoginUser();
    expect((await api(outsider).get(`/api/workspaces/${w.workspaceId}/my-tasks`)).status).toBe(404);
  });

  it('report and workload count what is in the project', async () => {
    const w = await setup();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await newTask(w.lead, w.projectId, { assigneeId: w.member.user.id, dueDate: past, estimateHours: 3 });
    await newTask(w.lead, w.projectId, { assigneeId: w.member.user.id, status: 'IN_PROGRESS', estimateHours: 2 });
    const done = await newTask(w.lead, w.projectId);
    await api(w.lead).patch(`/api/tasks/${done.id}`, { status: 'DONE' });
    await newTask(w.lead, w.projectId, { status: 'CANCELLED' });

    const report = await api(w.member).get(`/api/projects/${w.projectId}/report`);
    expect(report.status).toBe(200);
    expect(report.body.totals).toEqual({ all: 4, open: 2, done: 1, cancelled: 1, overdue: 1, unassigned: 0, completionPercent: 33 });
    expect(report.body.byStatus).toMatchObject({ TODO: 1, IN_PROGRESS: 1, DONE: 1, CANCELLED: 1 });
    expect(report.body.completedByWeek).toHaveLength(8);
    expect(report.body.completedByWeek.reduce((n: number, w: { count: number }) => n + w.count, 0)).toBe(1);

    const workload = await api(w.lead).get(`/api/workspaces/${w.workspaceId}/workload?projectId=${w.projectId}`);
    expect(workload.body.people).toEqual([
      expect.objectContaining({ user: expect.objectContaining({ id: w.member.user.id }), open: 2, inProgress: 1, overdue: 1, estimateHours: 5 }),
    ]);
    expect(workload.body.people[0].user).not.toHaveProperty('email');

    const projects = await api(w.lead).get(`/api/workspaces/${w.workspaceId}/projects`);
    expect(projects.body.projects.find((p: { id: string }) => p.id === w.projectId).taskCounts).toEqual({ total: 4, open: 2, done: 1, overdue: 1 });
  });
});

describe('tasks: sharing to chat', () => {
  it('posts a link message in a channel the sender can post in — never across workspaces or out of a private project', async () => {
    const w = await setup();
    const task = await newTask(w.lead, w.projectId, { title: 'Launch <b>plan</b>' });
    const shared = await api(w.member).post(`/api/tasks/${task.id}/share`, { channelId: w.generalChannelId, note: 'FYI' });
    expect(shared.status).toBe(200);
    const message = await prisma.message.findUniqueOrThrow({ where: { id: shared.body.messageId } });
    expect(message.channelId).toBe(w.generalChannelId);
    expect(message.content).toContain(`/projects/${w.projectId}?task=${task.id}`);
    expect(message.content).toContain('WEB-1');
    expect(message.content).not.toContain('<b>'); // title is escaped
    // Not a member of the target channel / another workspace's channel.
    const other = await setup();
    expect((await api(w.member).post(`/api/tasks/${task.id}/share`, { channelId: other.generalChannelId })).status).toBe(404);
    expect((await api(other.lead).post(`/api/tasks/${task.id}/share`, { channelId: other.generalChannelId })).status).toBe(404);
    // A private project's task stays inside the project's own channels.
    await api(w.lead).patch(`/api/projects/${w.projectId}`, { visibility: 'PRIVATE' });
    expect((await api(w.lead).post(`/api/tasks/${task.id}/share`, { channelId: w.generalChannelId })).status).toBe(403);
  });
});

describe('tasks: overdue reminders', () => {
  it('reminds the assignee once, even when two instances run the job at the same time', async () => {
    const w = await setup();
    const task = await newTask(w.lead, w.projectId, { assigneeId: w.member.user.id, dueDate: new Date(Date.now() - 3_600_000).toISOString() });
    await Promise.all([runOverdueReminders(), runOverdueReminders()]);
    await runOverdueReminders();
    expect(await prisma.workNotification.count({ where: { taskId: task.id, type: 'task_overdue' } })).toBe(1);
    // A new due date re-arms the reminder.
    await api(w.lead).patch(`/api/tasks/${task.id}`, { dueDate: new Date(Date.now() - 60_000).toISOString() });
    await runOverdueReminders();
    expect(await prisma.workNotification.count({ where: { taskId: task.id, type: 'task_overdue' } })).toBe(2);
  });
});

describe('projects: lifecycle fields', () => {
  it('stores status, key, review rule and dates, validating each', async () => {
    const w = await setup();
    const res = await api(w.lead).patch(`/api/projects/${w.projectId}`, { status: 'ON_HOLD', key: 'site', requireReview: true, startDate: '2026-11-01', dueDate: '2026-12-31' });
    expect(res.status).toBe(200);
    expect(res.body.project ?? res.body).toMatchObject({ status: 'ON_HOLD', key: 'SITE', requireReview: true });
    for (const body of [{ status: 'ARCHIVED' }, { key: '1AB' }, { key: 'TOOLONGKEY' }, { requireReview: 'yes' }, { startDate: '2027-01-02', dueDate: '2027-01-01' }]) {
      expect((await api(w.lead).patch(`/api/projects/${w.projectId}`, body)).status).toBe(400);
    }
    expect((await api(w.member).patch(`/api/projects/${w.projectId}`, { status: 'COMPLETED' })).status).toBe(403);
  });
});
