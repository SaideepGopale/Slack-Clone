import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, createTeamLead } from './helpers';
import { collect, nextEvent, useSocketHarness } from './socket-harness';

/**
 * T.38 — Team Lead → member task assignment. Tasks created from the Team Lead
 * dashboard are PRIVATE ASSIGNMENTS: visible only to their assignee, their
 * creator and the workspace's leads — on every endpoint and every socket
 * event. Members work on their own (status, comments); leads manage.
 */

const { connect } = useSocketHarness();

const as = (u: TestUser) => ({
  get: (path: string) => request(app).get(path).set(authHeader(u.token)),
  post: (path: string, body: object = {}) => request(app).post(path).set(authHeader(u.token)).send(body),
  patch: (path: string, body: object = {}) => request(app).patch(path).set(authHeader(u.token)).send(body),
  del: (path: string) => request(app).delete(path).set(authHeader(u.token)),
});

/** A Team Lead's workspace with Sahil, Developer 2 and Developer 3 as members. */
const team = async () => {
  const lead = await createTeamLead();
  const { workspaceId } = await createWorkspace(lead, `SmartUnifolio ${Date.now()}-${Math.random()}`);
  const [sahil, dev2, dev3] = [await createAndLoginUser(), await createAndLoginUser(), await createAndLoginUser()];
  for (const m of [sahil, dev2, dev3]) {
    const added = await as(lead).post(`/api/workspaces/${workspaceId}/members`, { userId: m.user.id });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  }
  return { lead, sahil, dev2, dev3, workspaceId, base: `/api/workspaces/${workspaceId}/team-tasks` };
};

const assign = async (lead: TestUser, base: string, assignee: TestUser, title: string, extra: Record<string, unknown> = {}) => {
  const res = await as(lead).post(base, { title, assigneeId: assignee.user.id, priority: 'HIGH', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.task as { id: string; title: string; status: string; projectId: string; assigneeOnly: boolean; assignee: { id: string }; creator: { id: string } };
};

const myIds = async (u: TestUser, workspaceId: string, view = 'assigned') =>
  ((await as(u).get(`/api/workspaces/${workspaceId}/my-tasks?view=${view}`)).body.tasks as { id: string }[]).map((t) => t.id).sort();

describe('T.38 — Team Lead creates private assignments; each member sees exactly their own', () => {
  it('5 / 3 / 2 tasks: persisted correctly, one "Team tasks" project, exact per-member lists, all ten for the lead', async () => {
    const { lead, sahil, dev2, dev3, workspaceId, base } = await team();
    const created: Record<string, string[]> = { sahil: [], dev2: [], dev3: [] };
    for (let i = 1; i <= 5; i++) created.sahil.push((await assign(lead, base, sahil, `Sahil task ${i}`)).id);
    for (let i = 1; i <= 3; i++) created.dev2.push((await assign(lead, base, dev2, `Dev2 task ${i}`)).id);
    for (let i = 1; i <= 2; i++) created.dev3.push((await assign(lead, base, dev3, `Dev3 task ${i}`)).id);

    const row = await prisma.task.findUniqueOrThrow({ where: { id: created.sahil[0] }, include: { project: true } });
    expect(row).toMatchObject({ workspaceId, assigneeId: sahil.user.id, creatorId: lead.user.id, status: 'TODO', assigneeOnly: true });
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { teamTasksProjectId: true } });
    expect(ws.teamTasksProjectId).toBe(row.projectId);
    expect(row.project).toMatchObject({ name: 'Team tasks', visibility: 'PRIVATE', workspaceId });
    expect(await prisma.project.count({ where: { workspaceId, name: 'Team tasks' } })).toBe(1);

    expect(await myIds(sahil, workspaceId)).toEqual([...created.sahil].sort());
    expect(await myIds(dev2, workspaceId)).toEqual([...created.dev2].sort());
    expect(await myIds(dev3, workspaceId)).toEqual([...created.dev3].sort());

    const all = await as(lead).get(base);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(10);
    expect((all.body.tasks as unknown[]).length).toBe(10);
    const summary = (await as(lead).get(`${base}/summary`)).body;
    expect(summary.totals).toMatchObject({ total: 10, todo: 10, inProgress: 0, completed: 0, overdue: 0 });
    const byUser = Object.fromEntries((summary.members as { user: { id: string }; total: number; completed: number; completionRate: number }[]).map((m) => [m.user.id, m]));
    expect(byUser[sahil.user.id]).toMatchObject({ total: 5, completed: 0, inProgress: 0, pending: 5, overdue: 0, completionRate: 0 });
    expect(byUser[dev2.user.id]).toMatchObject({ total: 3 });
    expect(byUser[dev3.user.id]).toMatchObject({ total: 2 });
    // Filters.
    expect((await as(lead).get(`${base}?assigneeId=${dev2.user.id}`)).body.total).toBe(3);
    expect((await as(lead).get(`${base}?q=Dev3%20task%202`)).body.total).toBe(1);
  });

  it('a member moves their task to In progress and Completed (completedAt), and the lead’s numbers follow', async () => {
    const { lead, sahil, workspaceId, base } = await team();
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push((await assign(lead, base, sahil, `S${i}`)).id);
    expect((await as(sahil).patch(`/api/tasks/${ids[0]}`, { status: 'IN_PROGRESS' })).status).toBe(200);
    expect((await as(lead).get(`${base}/summary`)).body.totals).toMatchObject({ inProgress: 1, todo: 4 });
    const done = await as(sahil).patch(`/api/tasks/${ids[0]}`, { status: 'DONE' });
    expect(done.status).toBe(200);
    expect(done.body.task.completedAt).toBeTruthy();
    const summary = (await as(lead).get(`${base}/summary`)).body;
    expect(summary.totals).toMatchObject({ total: 5, completed: 1, inProgress: 0, todo: 4 });
    expect(summary.members.find((m: { user: { id: string } }) => m.user.id === sahil.user.id)).toMatchObject({ total: 5, completed: 1, completionRate: 20 });
    expect(await myIds(sahil, workspaceId, 'done')).toEqual([ids[0]]);
  });
});

describe('T.38 — another member’s task is unreachable, on every endpoint', () => {
  it('direct ids, comments, moves, deletion, dependencies, sharing, the project board, search and workload', async () => {
    const { lead, sahil, dev2, workspaceId, base } = await team();
    const task = await assign(lead, base, sahil, 'Quarterly payroll reconciliation');
    const mine = await assign(lead, base, dev2, 'Dev2 own task');
    const general = await prisma.channel.findFirstOrThrow({ where: { workspaceId, name: 'General' }, select: { id: true } });

    const attempts: [string, () => Promise<request.Response>][] = [
      ['GET task', () => as(dev2).get(`/api/tasks/${task.id}`)],
      ['PATCH task', () => as(dev2).patch(`/api/tasks/${task.id}`, { status: 'DONE' })],
      ['GET comments', () => as(dev2).get(`/api/tasks/${task.id}/comments`)],
      ['POST comment', () => as(dev2).post(`/api/tasks/${task.id}/comments`, { body: 'hi' })],
      ['POST move', () => as(dev2).post(`/api/tasks/${task.id}/move`, { status: 'DONE' })],
      ['DELETE task', () => as(dev2).del(`/api/tasks/${task.id}`)],
      ['POST dependency', () => as(dev2).post(`/api/tasks/${mine.id}/dependencies`, { dependsOnId: task.id })],
      ['POST share', () => as(dev2).post(`/api/tasks/${task.id}/share`, { channelId: general.id })],
      ['GET project board', () => as(dev2).get(`/api/projects/${task.projectId}/tasks`)],
    ];
    for (const [label, attempt] of attempts) {
      const res = await attempt();
      expect([403, 404], `${label} → ${res.status}`).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain('Quarterly payroll');
    }
    expect((await as(dev2).get(`/api/tasks/${task.id}`)).status).toBe(404); // indistinguishable from "no such task"

    const search = await as(dev2).get(`/api/workspaces/${workspaceId}/search/all?q=Quarterly`);
    expect(JSON.stringify(search.body)).not.toContain('Quarterly payroll');
    const workload = await as(dev2).get(`/api/workspaces/${workspaceId}/workload`);
    expect(((workload.body.people ?? []) as { user: { id: string } }[]).some((p) => p.user.id === sahil.user.id)).toBe(false);
    for (const view of ['assigned', 'created', 'overdue', 'due-soon', 'completed', 'todo', 'in-progress', 'done']) {
      expect(await myIds(dev2, workspaceId, view)).not.toContain(task.id);
    }
    // Still fine for the assignee and the lead.
    expect((await as(sahil).get(`/api/tasks/${task.id}`)).status).toBe(200);
    expect((await as(lead).get(`/api/tasks/${task.id}`)).status).toBe(200);
    // Private assignments are never shared into channels, even by the lead.
    expect((await as(lead).post(`/api/tasks/${task.id}/share`, { channelId: general.id })).status).toBe(403);
  });
});

describe('T.38 — permissions: members work on their own tasks, leads manage', () => {
  it('a member changes status and comments, but cannot edit, reassign, cancel or delete; the lead can', async () => {
    const { lead, sahil, dev2, base } = await team();
    const task = await assign(lead, base, sahil, 'Prepare release notes');
    expect((await as(sahil).post(`/api/tasks/${task.id}/comments`, { body: 'Starting today' })).status).toBe(201);
    expect((await as(sahil).patch(`/api/tasks/${task.id}`, { title: 'Renamed' })).status).toBe(403);
    expect((await as(sahil).patch(`/api/tasks/${task.id}`, { assigneeId: dev2.user.id })).status).toBe(403);
    expect((await as(sahil).patch(`/api/tasks/${task.id}`, { assigneeId: null })).status).toBe(403);
    expect((await as(sahil).patch(`/api/tasks/${task.id}`, { status: 'CANCELLED' })).status).toBe(403);
    expect((await as(sahil).del(`/api/tasks/${task.id}`)).status).toBe(403);

    expect((await as(lead).patch(`/api/tasks/${task.id}`, { title: 'Prepare release notes v2', priority: 'URGENT' })).status).toBe(200);
    // Reassignment moves access with it.
    expect((await as(lead).patch(`/api/tasks/${task.id}`, { assigneeId: dev2.user.id })).status).toBe(200);
    expect((await as(sahil).get(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await as(dev2).get(`/api/tasks/${task.id}`)).status).toBe(200);
    expect((await as(lead).patch(`/api/tasks/${task.id}`, { status: 'CANCELLED' })).status).toBe(200);
    expect((await as(lead).del(`/api/tasks/${task.id}`)).status).toBe(200);
  });

  it('only a lead of this workspace manages team tasks; ids and fields from the request are never trusted', async () => {
    const { lead, sahil, dev2, workspaceId, base } = await team();
    const outsider = await createAndLoginUser();
    const otherLead = await createTeamLead();
    const { workspaceId: otherWorkspaceId } = await createWorkspace(otherLead);

    for (const res of [await as(sahil).post(base, { title: 'x', assigneeId: dev2.user.id }), await as(sahil).get(`${base}/summary`), await as(sahil).get(base), await as(sahil).get(`${base}/options`)]) {
      expect(res.status).toBe(403);
    }
    for (const actor of [outsider, otherLead]) {
      expect((await as(actor).post(base, { title: 'x', assigneeId: sahil.user.id })).status).toBe(404);
      expect((await as(actor).get(`${base}/summary`)).status).toBe(404);
    }
    // Assignee must be an active member of THIS workspace.
    expect((await as(lead).post(base, { title: 'x', assigneeId: outsider.user.id })).status).toBe(400);
    await prisma.user.update({ where: { id: dev2.user.id }, data: { status: 'SUSPENDED' } });
    expect((await as(lead).post(base, { title: 'x', assigneeId: dev2.user.id })).status).toBe(400);
    expect((await as(lead).post(base, { assigneeId: sahil.user.id })).status).toBe(400); // title required
    expect((await as(lead).post(base, { title: 'x' })).status).toBe(400); // assignee required
    // Status, creator, workspace and visibility in the body are ignored.
    const res = await as(lead).post(base, { title: 'Spoofed fields', assigneeId: sahil.user.id, status: 'DONE', creatorId: sahil.user.id, workspaceId: otherWorkspaceId, assigneeOnly: false });
    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({ status: 'TODO', assigneeOnly: true, workspaceId, creator: { id: lead.user.id } });
    // A project of another workspace cannot be used.
    const foreignProject = await as(otherLead).post(`/api/workspaces/${otherWorkspaceId}/projects`, { name: 'Elsewhere' });
    expect((await as(lead).post(base, { title: 'x', assigneeId: sahil.user.id, projectId: foreignProject.body.id ?? foreignProject.body.project?.id })).status).toBe(404);
    // The options list offers exactly this workspace's active members.
    const options = (await as(lead).get(`${base}/options`)).body;
    const offered = (options.members as { id: string }[]).map((m) => m.id);
    expect(offered).toEqual(expect.arrayContaining([lead.user.id, sahil.user.id]));
    expect(offered).not.toContain(outsider.user.id);
    expect(offered).not.toContain(dev2.user.id); // suspended
  });
});

describe('T.38 — live updates go only to the assignee and the leads', () => {
  it('create, status changes and reassignment: the right sockets get events, other members get none', async () => {
    const { lead, sahil, dev2, base } = await team();
    const [leadSock, sahilSock, dev2Sock] = [await connect(lead), await connect(sahil), await connect(dev2)];
    const leaked = collect<{ task?: { title: string } }>(dev2Sock.socket, 'task:upserted', 2500);

    const toLead = nextEvent<{ task: { title: string } }>(leadSock.socket, 'task:upserted', (p) => p.task.title === 'Secret roadmap');
    const toSahil = nextEvent<{ task: { title: string } }>(sahilSock.socket, 'task:upserted', (p) => p.task.title === 'Secret roadmap');
    const task = await assign(lead, base, sahil, 'Secret roadmap');
    await Promise.all([toLead, toSahil]);

    const leadSeesProgress = nextEvent<{ task: { id: string; status: string } }>(leadSock.socket, 'task:upserted', (p) => p.task.id === task.id && p.task.status === 'IN_PROGRESS');
    expect((await as(sahil).patch(`/api/tasks/${task.id}`, { status: 'IN_PROGRESS' })).status).toBe(200);
    await leadSeesProgress;
    expect((await leaked).filter((p) => p.task?.title === 'Secret roadmap')).toEqual([]);

    // Reassigned to Developer 2: Sahil is told it is gone, Developer 2 receives it.
    const gone = nextEvent<{ taskId: string }>(sahilSock.socket, 'task:deleted', (p) => p.taskId === task.id);
    const arrived = nextEvent<{ task: { id: string } }>(dev2Sock.socket, 'task:upserted', (p) => p.task.id === task.id);
    expect((await as(lead).patch(`/api/tasks/${task.id}`, { assigneeId: dev2.user.id })).status).toBe(200);
    await Promise.all([gone, arrived]);
  });
});
