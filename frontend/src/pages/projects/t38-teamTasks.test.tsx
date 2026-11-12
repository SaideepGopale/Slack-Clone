import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '../../lib/api/tasks';

/**
 * T.38 — the Team Lead dashboard, the Create task dialog and the member's
 * My Tasks actions, against a mocked API and a scripted socket.
 */
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('react-toastify', () => ({ toast }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'sahil', username: 'sahil' } }) }));
const handlers = new Map<string, Set<(payload: unknown) => void>>();
const socket = {
  on: (event: string, fn: (payload: unknown) => void) => void (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(fn),
  off: (event: string, fn: (payload: unknown) => void) => void handlers.get(event)?.delete(fn),
  emit: vi.fn(),
};
const serverEmit = (event: string, payload: unknown) => act(() => handlers.get(event)?.forEach((fn) => fn(payload)));
vi.mock('../workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ workspaceId: 'ws', socket, channels: [] }) }));
vi.mock('../workspace/WorkspacesProvider', () => ({ useWorkspaces: () => ({ getWorkspace: () => ({ id: 'ws', name: 'SmartUnifolio' }) }), useOptionalWorkspaces: () => null }));
vi.mock('../../components/tasks/TaskDrawer', () => ({ TaskDrawer: ({ taskId }: { taskId: string }) => <div role="dialog" aria-label={`Task ${taskId}`} /> }));

import { CreateTeamTaskModal } from '../../components/tasks/team/CreateTeamTaskModal';
import { MyTasksPage } from './MyTasksPage';
import { TeamTasksPage } from './TeamTasksPage';

const api = vi.mocked(axios, true);
const person = (id: string, username: string) => ({ id, username, displayName: null });
const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({
  id,
  projectId: 'team',
  workspaceId: 'ws',
  number: 1,
  identifier: `TEAM-${id}`,
  title: `Task ${id}`,
  description: null,
  status: 'TODO',
  priority: 'HIGH',
  assignee: person('sahil', 'sahil'),
  creator: person('lead', 'lead'),
  parentId: null,
  startDate: null,
  dueDate: null,
  estimateHours: null,
  actualHours: null,
  labels: [],
  position: 1,
  completedAt: null,
  createdAt: '2026-11-11T10:00:00.000Z',
  updatedAt: '2026-11-11T10:00:00.000Z',
  subtaskCount: 0,
  subtasksDone: 0,
  commentCount: 0,
  openBlockerCount: 0,
  overdue: false,
  assigneeOnly: true,
  ...extra,
});

const SUMMARY = {
  totals: { total: 10, todo: 8, inProgress: 1, completed: 1, overdue: 0, cancelled: 0, unassigned: 0 },
  members: [
    { user: person('sahil', 'sahil'), workspaceRole: 'MEMBER', total: 5, pending: 3, inProgress: 1, completed: 1, overdue: 0, completionRate: 20 },
    { user: person('dev2', 'dev2'), workspaceRole: 'MEMBER', total: 3, pending: 3, inProgress: 0, completed: 0, overdue: 0, completionRate: 0 },
  ],
};
const OPTIONS = { members: [{ ...person('sahil', 'sahil'), workspaceRole: 'MEMBER' }, { ...person('dev2', 'dev2'), workspaceRole: 'MEMBER' }], projects: [] };

beforeEach(() => handlers.clear());
afterEach(() => vi.clearAllMocks());

describe('Team Lead dashboard (T.38)', () => {
  const mockTeamApi = () =>
    api.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/team-tasks/summary')) return { data: SUMMARY };
      if (url.endsWith('/team-tasks/options')) return { data: OPTIONS };
      if (url.endsWith('/team-tasks')) return { data: { tasks: [task('a'), task('b', { assignee: person('dev2', 'dev2') })], nextCursor: null, total: 2 } };
      throw new Error(`unexpected GET ${url}`);
    });

  it('shows totals, per-member progress and the task table; a member row and a card filter the table', async () => {
    mockTeamApi();
    render(<MemoryRouter><TeamTasksPage /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Total tasks: 10' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Completed: 1' })).toBeInTheDocument();
    const sahil = screen.getByRole('button', { name: /^sahil: 1 of 5 completed \(20%\)/ });
    expect(within(sahil).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
    expect(await screen.findByRole('table', { name: 'Team tasks' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2

    fireEvent.click(sahil);
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/ws/team-tasks', { params: { assigneeId: 'sahil', limit: 50 } }));
    fireEvent.click(screen.getByRole('button', { name: 'In progress: 1' }));
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/ws/team-tasks', { params: { assigneeId: 'sahil', status: 'in_progress', limit: 50 } }));
  });

  it('refreshes live when a task of this workspace changes', async () => {
    mockTeamApi();
    render(<MemoryRouter><TeamTasksPage /></MemoryRouter>);
    await screen.findByRole('table', { name: 'Team tasks' });
    const before = api.get.mock.calls.filter(([u]) => String(u).endsWith('/summary')).length;
    serverEmit('task:upserted', { task: task('a', { status: 'DONE' }) });
    await waitFor(() => expect(api.get.mock.calls.filter(([u]) => String(u).endsWith('/summary')).length).toBeGreaterThan(before));
  });

  it('a member (403) is told this page is for Team Leads', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 403, data: { error: "Only this workspace's Team Lead can manage team tasks." } } }));
    render(<MemoryRouter><TeamTasksPage /></MemoryRouter>);
    expect(await screen.findByText('Team tasks are for Team Leads')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
  });
});

describe('Create task dialog (T.38)', () => {
  it('needs a title and a member, sends only the form fields, then stays open for the next task', async () => {
    api.post.mockResolvedValue({ data: { task: task('n1', { title: 'Write tests' }) } });
    const onCreated = vi.fn();
    render(<CreateTeamTaskModal workspaceId="ws" options={OPTIONS as never} onCreated={onCreated} onClose={vi.fn()} />);
    const assign = screen.getByRole('button', { name: 'Assign task' });
    expect(assign).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Write tests' } });
    expect(assign).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'sahil' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'URGENT' } });
    fireEvent.click(assign);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/api/workspaces/ws/team-tasks', { title: 'Write tests', assigneeId: 'sahil', priority: 'URGENT' });
    expect(screen.getByRole('status')).toHaveTextContent('Assigned “Write tests” to sahil.');
    expect(screen.getByLabelText('Task title')).toHaveValue('');
    expect(screen.getByLabelText('Assign to')).toHaveValue('sahil'); // kept for the next one
  });
});

describe('My Tasks — the member’s actions (T.38)', () => {
  const counts = { assigned: 2, created: 0, overdue: 0, dueSoon: 0, completed: 1, todo: 1, inProgress: 1, done: 1 };
  const mine = [task('t1', { title: 'Draft brief', description: 'One page.' }), task('t2', { title: 'Review PR', status: 'IN_PROGRESS' })];

  it('Start moves a task to In progress; Mark complete asks first, then completes it', async () => {
    api.get.mockResolvedValue({ data: { tasks: mine, nextCursor: null, counts } });
    api.patch.mockImplementation(async (_url: string, body?: unknown) => {
      const status = (body as { status: TaskView['status'] }).status;
      return { data: { task: task(status === 'DONE' ? 't2' : 't1', { status, completedAt: status === 'DONE' ? '2026-11-11T12:30:00.000Z' : null }) } };
    });
    render(<MemoryRouter><MyTasksPage /></MemoryRouter>);
    expect(await screen.findByText('One page.')).toBeInTheDocument();
    expect(screen.getAllByText('Assigned by lead')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Start Draft brief' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tasks/t1', { status: 'IN_PROGRESS' }));

    fireEvent.click(screen.getByRole('button', { name: 'Mark Review PR as completed' }));
    const confirm = await screen.findByRole('dialog', { name: 'Mark this task as completed?' });
    expect(api.patch).toHaveBeenCalledTimes(1); // nothing sent before confirming
    fireEvent.click(within(confirm).getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith('/api/tasks/t2', { status: 'DONE' }));
    expect(await screen.findByText(/Completed Nov 11/)).toBeInTheDocument();
  });

  it('a private assignment opens its details here; no Start/Complete on tasks assigned to someone else', async () => {
    api.get.mockResolvedValue({ data: { tasks: [mine[0], task('t3', { assignee: person('dev2', 'dev2') })], nextCursor: null, counts } });
    render(<MemoryRouter><MyTasksPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open TEAM-t1: Draft brief' }));
    expect(screen.getByRole('dialog', { name: 'Task t1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Task t3' })).not.toBeInTheDocument();
  });
});
