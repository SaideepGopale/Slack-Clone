import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectsApi, tasksApi } from '.';

vi.mock('axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } },
}));
const api = vi.mocked(axios, true);

beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

describe('tasks API client (T.33)', () => {
  it('lists tasks with only meaningful filters, joining lists', async () => {
    await tasksApi.listTasks('p1');
    expect(api.get).toHaveBeenLastCalledWith('/api/projects/p1/tasks');
    await tasksApi.listTasks('p1', { status: ['TODO', 'IN_PROGRESS'], assigneeId: 'me', priority: [], q: '', parent: 'root', limit: 500 });
    expect(api.get).toHaveBeenLastCalledWith('/api/projects/p1/tasks', { params: { status: 'TODO,IN_PROGRESS', assigneeId: 'me', parent: 'root', limit: 500 } });
  });

  it('creates, reads, updates, moves and deletes tasks at the contract paths', async () => {
    await tasksApi.createTask('p1', { title: 'Ship it', status: 'TODO' });
    expect(api.post).toHaveBeenLastCalledWith('/api/projects/p1/tasks', { title: 'Ship it', status: 'TODO' });
    await tasksApi.getTask('t1');
    expect(api.get).toHaveBeenLastCalledWith('/api/tasks/t1');
    await tasksApi.updateTask('t1', { assigneeId: null });
    expect(api.patch).toHaveBeenLastCalledWith('/api/tasks/t1', { assigneeId: null });
    await tasksApi.moveTask('t1', { status: 'DONE', prevId: 'a', nextId: null });
    expect(api.post).toHaveBeenLastCalledWith('/api/tasks/t1/move', { status: 'DONE', prevId: 'a', nextId: null });
    await tasksApi.deleteTask('t1');
    expect(api.delete).toHaveBeenLastCalledWith('/api/tasks/t1');
  });

  it('comments, dependencies and sharing', async () => {
    await tasksApi.listComments('t1', 'c9');
    expect(api.get).toHaveBeenLastCalledWith('/api/tasks/t1/comments', { params: { cursor: 'c9' } });
    await tasksApi.addComment('t1', 'Looks good');
    expect(api.post).toHaveBeenLastCalledWith('/api/tasks/t1/comments', { body: 'Looks good' });
    await tasksApi.editComment('c1', 'Edited');
    expect(api.patch).toHaveBeenLastCalledWith('/api/task-comments/c1', { body: 'Edited' });
    await tasksApi.deleteComment('c1');
    expect(api.delete).toHaveBeenLastCalledWith('/api/task-comments/c1');
    await tasksApi.addDependency('t1', 't2');
    expect(api.post).toHaveBeenLastCalledWith('/api/tasks/t1/dependencies', { dependsOnId: 't2' });
    await tasksApi.removeDependency('t1', 't2');
    expect(api.delete).toHaveBeenLastCalledWith('/api/tasks/t1/dependencies/t2');
    await tasksApi.shareTask('t1', 'ch1');
    expect(api.post).toHaveBeenLastCalledWith('/api/tasks/t1/share', { channelId: 'ch1' });
    await tasksApi.shareTask('t1', 'ch1', 'FYI');
    expect(api.post).toHaveBeenLastCalledWith('/api/tasks/t1/share', { channelId: 'ch1', note: 'FYI' });
  });

  it('workspace-level views, reports and notifications', async () => {
    await tasksApi.listMyTasks('ws', 'overdue', { limit: 50 });
    expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/ws/my-tasks', { params: { view: 'overdue', limit: 50 } });
    await tasksApi.getWorkload('ws', 'p1');
    expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/ws/workload', { params: { projectId: 'p1' } });
    await tasksApi.getWorkload('ws');
    expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/ws/workload');
    await tasksApi.getProjectReport('p1');
    expect(api.get).toHaveBeenLastCalledWith('/api/projects/p1/report');
    await tasksApi.listWorkNotifications('ws', { unread: true, limit: 20 });
    expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/ws/work-notifications', { params: { unread: 1, limit: 20 } });
    await tasksApi.markWorkNotificationsRead('ws', { all: true });
    expect(api.post).toHaveBeenLastCalledWith('/api/work-notifications/read', { workspaceId: 'ws', all: true });
  });

  it('encodes ids in paths', async () => {
    await tasksApi.getTask('a/b?c');
    expect(api.get).toHaveBeenLastCalledWith('/api/tasks/a%2Fb%3Fc');
  });

  it('project create/update/members helpers', async () => {
    await projectsApi.createProject('ws', { name: 'Web', key: 'WEB', status: 'PLANNING' });
    expect(api.post).toHaveBeenLastCalledWith('/api/workspaces/ws/projects', { name: 'Web', key: 'WEB', status: 'PLANNING' });
    await projectsApi.updateProject('p1', { status: 'ON_HOLD' });
    expect(api.patch).toHaveBeenLastCalledWith('/api/projects/p1', { status: 'ON_HOLD' });
    await projectsApi.listProjectMembers('p1');
    expect(api.get).toHaveBeenLastCalledWith('/api/projects/p1/members', { params: { limit: 100 } });
  });

  it('reads capabilities in either naming', () => {
    const project = { capabilities: { createTask: true, canUpdate: true } } as unknown as projectsApi.ProjectDetails;
    expect(projectsApi.projectCan(project, 'createTask')).toBe(true);
    expect(projectsApi.projectCan(project, 'update')).toBe(true);
    expect(projectsApi.projectCan(project, 'manageTasks')).toBe(false);
    expect(projectsApi.projectCan(null, 'update')).toBe(false);
  });
});
