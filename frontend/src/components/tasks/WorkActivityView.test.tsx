import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** T.33 — task activity: lists, live updates, opens the task, marks read. */
const axiosMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), defaults: { headers: { common: {} } } }));
vi.mock('axios', () => ({ default: axiosMock }));
const listeners = new Map<string, (payload: unknown) => void>();
const socket = { on: vi.fn((event: string, cb: (p: unknown) => void) => listeners.set(event, cb)), off: vi.fn() };
vi.mock('../../pages/workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ workspaceId: 'ws1', socket }) }));

import { WorkActivityView } from './WorkActivityView';

const Where = () => <div data-testid="where">{useLocation().pathname + useLocation().search}</div>;
const note = (id: string, extra: object = {}) => ({ id, type: 'task_assigned', title: `WEB-${id} Fix it`, body: 'You were assigned this task.', taskId: `t${id}`, projectId: 'p1', actor: { id: 'u2', username: 'ann', displayName: 'Ann' }, readAt: null, createdAt: new Date().toISOString(), ...extra });

beforeEach(() => {
  listeners.clear();
  axiosMock.get.mockResolvedValue({ data: { notifications: [note('1'), note('2', { type: 'task_overdue', readAt: new Date().toISOString() })], unreadCount: 1 } });
  axiosMock.post.mockResolvedValue({ data: { updated: 1 } });
});
afterEach(() => vi.clearAllMocks());

const renderView = () =>
  render(
    <MemoryRouter initialEntries={['/ws1/activity?tab=tasks']}>
      <Routes>
        <Route path="*" element={<><WorkActivityView /><Where /></>} />
      </Routes>
    </MemoryRouter>
  );

describe('WorkActivityView (T.33)', () => {
  it('lists task activity with unread state and opens the task, marking it read', async () => {
    renderView();
    expect(await screen.findByText('WEB-1 Fix it')).toBeInTheDocument();
    expect(screen.getByText('1 unread')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /WEB-1 Fix it/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/ws1/projects/p1?task=t1');
    expect(axiosMock.post).toHaveBeenCalledWith('/api/work-notifications/read', { workspaceId: 'ws1', ids: ['1'] });
  });

  it('adds live notifications and can mark everything read', async () => {
    renderView();
    await screen.findByText('WEB-1 Fix it');
    act(() => listeners.get('work:notification')?.({ notification: note('3', { type: 'task_comment', body: 'Looks good' }) }));
    expect(await screen.findByText('WEB-3 Fix it')).toBeInTheDocument();
    expect(screen.getByText('2 unread')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.getByText('You are all caught up')).toBeInTheDocument());
    expect(axiosMock.post).toHaveBeenCalledWith('/api/work-notifications/read', { workspaceId: 'ws1', all: true });
  });
});
