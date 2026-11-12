import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDetail, TaskView } from '../../lib/api/tasks';

/**
 * T.33 — projects & tasks screens against a mocked API (axios) and a scripted
 * socket: optimistic board moves and their rollback, live updates, the task
 * drawer's capability handling, My Tasks views and the create forms.
 */
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('react-toastify', () => ({ toast }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', username: 'ann' } }) }));

const handlers = new Map<string, Set<(payload: unknown) => void>>();
const socket = {
  on: (event: string, fn: (payload: unknown) => void) => void (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(fn),
  off: (event: string, fn: (payload: unknown) => void) => void handlers.get(event)?.delete(fn),
  emit: vi.fn(),
};
const serverEmit = (event: string, payload: unknown) => act(() => handlers.get(event)?.forEach((fn) => fn(payload)));
vi.mock('../workspace/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'ws', socket, channels: [{ id: 'ch1', name: 'general', isDM: false }] }),
}));

import { validateNewTask, NewTaskModal } from '../../components/tasks/TaskForms';
import { TaskDrawer } from '../../components/tasks/TaskDrawer';
import { MyTasksPage } from './MyTasksPage';
import { ProjectPage } from './ProjectPage';
import { ProjectsPage } from './ProjectsPage';

const api = vi.mocked(axios, true);

const task = (id: string, status: TaskView['status'], position: number, extra: Partial<TaskView> = {}): TaskView => ({
  id,
  projectId: 'p1',
  workspaceId: 'ws',
  number: Number(id.replace(/\D/g, '')),
  identifier: `WEB-${id.replace(/\D/g, '')}`,
  title: `Task ${id}`,
  description: null,
  status,
  priority: 'MEDIUM',
  assignee: null,
  creator: { id: 'me', username: 'ann', displayName: null },
  parentId: null,
  startDate: null,
  dueDate: null,
  estimateHours: null,
  actualHours: null,
  labels: [],
  position,
  completedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  subtaskCount: 0,
  subtasksDone: 0,
  commentCount: 0,
  openBlockerCount: 0,
  overdue: false,
  ...extra,
});

const project = {
  id: 'p1',
  workspaceId: 'ws',
  name: 'Website',
  description: null,
  visibility: 'PUBLIC',
  archived: false,
  archivedAt: null,
  memberCount: 2,
  channelCount: 0,
  myRole: 'OWNER',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  status: 'ACTIVE',
  key: 'WEB',
  requireReview: false,
  owner: { id: 'me', username: 'ann' },
  capabilities: { canUpdate: true, createTask: true, manageTasks: true },
};

const route = (url: string) => {
  if (url === '/api/projects/p1') return { data: project };
  if (url === '/api/projects/p1/tasks') return { data: { tasks: [task('t1', 'TODO', 1), task('t2', 'TODO', 2), task('t3', 'IN_PROGRESS', 1)], nextCursor: null } };
  if (url === '/api/projects/p1/members') return { data: { members: [{ userId: 'me', role: 'OWNER', joinedAt: '', user: { id: 'me', username: 'ann' } }], nextCursor: null } };
  throw new Error(`unexpected GET ${url}`);
};

beforeEach(() => {
  vi.resetAllMocks();
  handlers.clear();
  api.get.mockImplementation(async (url: string) => route(url));
});

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
};

const renderProject = (path = '/ws/projects/p1') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:workspaceId/projects/:projectId" element={<><ProjectPage /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>
  );

const column = (label: string) => screen.getByRole('listitem', { name: new RegExp(`^${label} column`) });

describe('project board', () => {
  it('renders columns in status order with the project’s tasks', async () => {
    renderProject();
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    const names = screen.getAllByRole('listitem', { name: / column/ }).map((c) => c.getAttribute('aria-label')!.split(' column')[0]);
    expect(names).toEqual(['Backlog', 'To do', 'In progress', 'In review', 'Blocked', 'Done', 'Cancelled']);
    expect(within(column('To do')).getAllByRole('button', { name: /^WEB-\d: / }).map((b) => b.getAttribute('aria-label'))).toEqual(['WEB-1: Task t1', 'WEB-2: Task t2']);
  });

  it('moves optimistically, persists the neighbours, and rolls back when the server refuses', async () => {
    let reject: (err: unknown) => void = () => undefined;
    api.post.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    renderProject();
    await screen.findByRole('heading', { level: 1, name: 'Website' });

    fireEvent.click(within(column('To do')).getByRole('button', { name: 'Move task WEB-1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Done' }));

    // Optimistic: already in Done.
    expect(within(column('Done')).getByRole('button', { name: 'WEB-1: Task t1' })).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/tasks/t1/move', { status: 'DONE', prevId: null, nextId: null });

    await act(async () =>
      reject({ response: { status: 409, data: { error: 'Finish the tasks this one depends on first.', blockers: [{ id: 't9', identifier: 'WEB-9', title: 'API', status: 'TODO' }] } } })
    );
    expect(within(column('To do')).getByRole('button', { name: 'WEB-1: Task t1' })).toBeInTheDocument();
    expect(within(column('Done')).queryByRole('button', { name: 'WEB-1: Task t1' })).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Finish the tasks this one depends on first. Open: WEB-9.');
  });

  it('keeps a successful move and sends the card above/below as neighbours', async () => {
    api.post.mockResolvedValueOnce({ data: { task: task('t1', 'TODO', 3) } });
    renderProject();
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    fireEvent.click(within(column('To do')).getByRole('button', { name: 'Move task WEB-1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
    expect(api.post).toHaveBeenCalledWith('/api/tasks/t1/move', { status: 'TODO', prevId: 't2', nextId: null });
    await waitFor(() =>
      expect(within(column('To do')).getAllByRole('button', { name: /^WEB-\d: / }).map((b) => b.getAttribute('aria-label'))).toEqual(['WEB-2: Task t2', 'WEB-1: Task t1'])
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('drops a dragged card into another column', async () => {
    api.post.mockResolvedValueOnce({ data: { task: task('t3', 'IN_REVIEW', 1) } });
    renderProject();
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    const card = within(column('In progress')).getByRole('button', { name: 'WEB-3: Task t3' });
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(card, { dataTransfer });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    fireEvent.dragOver(column('In review'), { dataTransfer, clientY: 10 });
    fireEvent.drop(column('In review'), { dataTransfer, clientY: 10 });
    expect(api.post).toHaveBeenCalledWith('/api/tasks/t3/move', { status: 'IN_REVIEW', prevId: null, nextId: null });
    await waitFor(() => expect(within(column('In review')).getByRole('button', { name: 'WEB-3: Task t3' })).toBeInTheDocument());
  });

  it('merges live task events from other people', async () => {
    renderProject();
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    serverEmit('task:upserted', { task: task('t7', 'BLOCKED', 1, { title: 'Live one' }) });
    expect(within(column('Blocked')).getByRole('button', { name: 'WEB-7: Live one' })).toBeInTheDocument();
    serverEmit('task:upserted', { task: task('t8', 'TODO', 1, { projectId: 'other' }) });
    expect(screen.queryByRole('button', { name: /^WEB-8/ })).not.toBeInTheDocument();
    serverEmit('task:deleted', { taskId: 't7', projectId: 'p1' });
    expect(screen.queryByRole('button', { name: 'WEB-7: Live one' })).not.toBeInTheDocument();
  });

  it('quick-adds a task to a column', async () => {
    api.post.mockResolvedValueOnce({ data: { task: task('t4', 'BACKLOG', 1, { title: 'Write tests' }) } });
    renderProject();
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    fireEvent.click(within(column('Backlog')).getByRole('button', { name: 'Add task' }));
    const input = screen.getByRole('textbox', { name: 'New task in Backlog' });
    fireEvent.change(input, { target: { value: 'Write tests' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(within(column('Backlog')).getByRole('button', { name: 'WEB-4: Write tests' })).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith('/api/projects/p1/tasks', { title: 'Write tests', status: 'BACKLOG' });
  });

  it('opens a card in the drawer via ?task= and filters the board', async () => {
    renderProject();
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks' }), { target: { value: 'WEB-2' } });
    expect(screen.queryByRole('button', { name: 'WEB-1: Task t1' })).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3 tasks')).toBeInTheDocument();
    api.get.mockImplementation(async (url: string) => (url === '/api/tasks/t2' ? { data: detail({ id: 't2', identifier: 'WEB-2', title: 'Task t2' }) } : route(url)));
    fireEvent.click(screen.getByRole('button', { name: 'WEB-2: Task t2' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/ws/projects/p1?task=t2');
    expect(await screen.findByRole('dialog', { name: 'Task t2' })).toBeInTheDocument();
  });
});

const detail = (extra: Partial<TaskDetail> = {}): TaskDetail => ({
  ...task('t1', 'TODO', 1),
  project: { id: 'p1', name: 'Website', key: 'WEB', workspaceId: 'ws', requireReview: true, archived: false },
  parent: null,
  subtasks: [],
  blockedBy: [],
  blocking: [],
  comments: [{ id: 'c1', body: 'First!', author: { id: 'bob', username: 'bob', displayName: null }, createdAt: '2026-11-02T00:00:00.000Z', editedAt: null, canEdit: false, canDelete: false }],
  activity: [{ id: 'a1', type: 'status', actor: { id: 'bob', username: 'bob', displayName: null }, data: { from: 'BACKLOG', to: 'TODO' }, createdAt: '2026-11-02T00:00:00.000Z' }],
  attachments: [],
  capabilities: { update: false, changeStatus: true, complete: false, assignOthers: false, assignSelf: true, delete: false, comment: false },
  ...extra,
});

describe('task drawer', () => {
  const renderDrawer = (d: TaskDetail) => {
    api.get.mockImplementation(async (url: string) => (url === `/api/tasks/${d.id}` ? { data: d } : route(url)));
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <TaskDrawer taskId={d.id} projectTasks={[]} members={[]} canCreateTask={false} onClose={vi.fn()} onChanged={onChanged} onDeleted={vi.fn()} onOpenTask={vi.fn()} />
      </MemoryRouter>
    );
    return { onChanged };
  };

  it('respects capabilities: read-only fields, review-gated Done, no delete/comment', async () => {
    renderDrawer(detail());
    expect(await screen.findByRole('heading', { name: 'Task t1' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Priority' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Done (lead review)' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete WEB-1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Write a comment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
    // Self-assignment only.
    const assignee = screen.getByRole('combobox', { name: 'Assignee' });
    expect(within(assignee).getAllByRole('option').map((o) => o.textContent)).toEqual(['Unassigned', 'Me']);
    expect(screen.getByText('First!')).toBeInTheDocument();
    expect(screen.getByText(/changed status from Backlog to To do/)).toBeInTheDocument();
  });

  it('saves a status change and reports it to the board', async () => {
    const updated = task('t1', 'IN_PROGRESS', 1);
    api.patch.mockResolvedValueOnce({ data: { task: updated } });
    const { onChanged } = renderDrawer(detail());
    fireEvent.change(await screen.findByRole('combobox', { name: 'Status' }), { target: { value: 'IN_PROGRESS' } });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated));
    expect(api.patch).toHaveBeenCalledWith('/api/tasks/t1', { status: 'IN_PROGRESS' });
  });

  it('a lead gets editable fields, delete, comments and the full assignee list', async () => {
    renderDrawer(
      detail({ capabilities: { update: true, changeStatus: true, complete: true, assignOthers: true, assignSelf: true, delete: true, comment: true } })
    );
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Task t1');
    expect(screen.getByRole('button', { name: 'Delete WEB-1' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Done' })).toBeEnabled();
  });

  it('uploads a file, links it to the task, shows it and can remove it', async () => {
    const att = { id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b', url: '/api/attachments/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b', name: 'spec.pdf', type: 'application/pdf', size: 1200 };
    const editable = { ...detail().capabilities, update: true };
    let withFile = false;
    api.get.mockImplementation(async (url: string) => {
      if (url === '/api/tasks/t1') return { data: detail({ capabilities: editable, attachments: withFile ? [att] : [] }) };
      if (url === att.url) return { data: { url: 'https://files.example/spec.pdf', expiresAt: new Date(Date.now() + 600_000).toISOString() } };
      return route(url);
    });
    api.post.mockImplementation(async (url: string) => {
      if (url === '/api/upload') return { data: { id: att.id, url: att.url, name: 'spec.pdf', type: 'application/pdf', size: 1200 } };
      if (url === '/api/tasks/t1/attachments') {
        withFile = true;
        return { data: { attachments: [att] } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    api.delete.mockImplementation(async () => {
      withFile = false;
      return { data: { attachments: [] } };
    });
    render(
      <MemoryRouter>
        <TaskDrawer taskId="t1" projectTasks={[]} members={[]} canCreateTask={false} onClose={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn()} onOpenTask={vi.fn()} />
      </MemoryRouter>
    );
    expect(await screen.findByText('No files yet.')).toBeInTheDocument();
    const file = new File(['%PDF-1.4'], 'spec.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('task-file-input'), { target: { files: [file] } });
    // (the progress row briefly shows the name too; the linked file has a Remove button)
    expect(await screen.findByRole('button', { name: 'Remove spec.pdf' })).toBeInTheDocument();
    expect(screen.getByText('spec.pdf')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/upload', expect.any(FormData), expect.objectContaining({ onUploadProgress: expect.any(Function) }));
    expect(api.post).toHaveBeenCalledWith('/api/tasks/t1/attachments', { attachmentId: att.id });

    fireEvent.click(screen.getByRole('button', { name: 'Remove spec.pdf' }));
    await waitFor(() => expect(screen.queryByText('spec.pdf')).not.toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith(`/api/tasks/t1/attachments/${att.id}`);
  });

  it('hides file controls without update rights', async () => {
    renderDrawer(detail());
    await screen.findByRole('heading', { name: 'Task t1' });
    expect(screen.queryByRole('button', { name: 'Attach file' })).not.toBeInTheDocument();
  });

  it('posts a comment', async () => {
    api.post.mockResolvedValueOnce({ data: { comment: {} } });
    renderDrawer(detail({ capabilities: { ...detail().capabilities, comment: true } }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Write a comment' }), { target: { value: 'On it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tasks/t1/comments', { body: 'On it' }));
  });
});

describe('My Tasks', () => {
  it('switches views and shows the counts', async () => {
    const counts = { assigned: 2, created: 1, overdue: 1, dueSoon: 0, completed: 5 };
    api.get.mockImplementation(async (_url: string, config?: { params?: { view?: string } }) => ({
      data: {
        tasks: config?.params?.view === 'overdue' ? [task('t5', 'TODO', 1, { title: 'Late thing', overdue: true, dueDate: '2026-11-01T23:59:59.999Z', project: { id: 'p1', name: 'Website', key: 'WEB' } })] : [task('t1', 'TODO', 1, { project: { id: 'p1', name: 'Website', key: 'WEB' } })],
        nextCursor: null,
        counts,
      },
    }));
    render(
      <MemoryRouter initialEntries={['/ws/tasks']}>
          <Routes>
          <Route path="/:workspaceId/tasks" element={<MyTasksPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    );
    expect(await screen.findByText('Task t1')).toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/ws/my-tasks', { params: { view: 'assigned', limit: 50 } });
    expect(screen.getByRole('tab', { name: /Completed/ })).toHaveTextContent('5');

    fireEvent.click(screen.getByRole('tab', { name: /Overdue/ }));
    expect(await screen.findByText('Late thing')).toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/ws/my-tasks', { params: { view: 'overdue', limit: 50 } });
    expect(screen.getByTestId('location')).toHaveTextContent('/ws/tasks?view=overdue');

    fireEvent.click(screen.getByText('Late thing'));
    expect(screen.getByTestId('location')).toHaveTextContent('/ws/projects/p1?task=t5');
  });
});

describe('create forms', () => {
  it('validates a new task before sending anything', async () => {
    expect(validateNewTask({ title: ' ', description: '', status: 'TODO', priority: 'LOW', assigneeId: '', startDate: '', dueDate: '', estimateHours: '', labels: '' }).title).toBeTruthy();
    expect(validateNewTask({ title: 'x', description: '', status: 'TODO', priority: 'LOW', assigneeId: '', startDate: '2026-11-10', dueDate: '2026-11-09', estimateHours: '-1', labels: '' })).toMatchObject({
      dueDate: expect.any(String),
      estimateHours: expect.any(String),
    });

    render(<NewTaskModal projectId="p1" members={[]} canAssignOthers={false} myId="me" onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Give the task a title.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('creates a task with dates stored as whole days', async () => {
    const onCreated = vi.fn();
    api.post.mockResolvedValueOnce({ data: { task: task('t9', 'TODO', 1) } });
    render(<NewTaskModal projectId="p1" members={[]} canAssignOthers={false} myId="me" onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Launch' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Labels'), { target: { value: 'release, web, release' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/api/projects/p1/tasks', { title: 'Launch', status: 'TODO', priority: 'MEDIUM', dueDate: '2026-12-01T23:59:59.999Z', labels: ['release', 'web'] });
  });

  it('lists projects with progress and suggests a key for a new one', async () => {
    api.get.mockResolvedValue({
      data: { projects: [{ ...project, taskCounts: { total: 4, open: 3, done: 1, overdue: 1 } }], nextCursor: null },
    });
    render(
      <MemoryRouter initialEntries={['/ws/projects']}>
        <Routes>
          <Route path="/:workspaceId/projects" element={<ProjectsPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Website' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Website progress' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText(/1 overdue/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mobile App Launch' } });
    expect(screen.getByLabelText('Key')).toHaveValue('MAL');
  });
});
