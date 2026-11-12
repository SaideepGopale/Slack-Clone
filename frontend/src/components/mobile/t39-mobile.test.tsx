import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLongPress } from '../../hooks/useLongPress';
import { BottomSheet, SheetAction } from '../ui/BottomSheet';
import { MobileTabBar, tabForView } from './MobileTabBar';

/** T.39 — phone/tablet building blocks. */

const ws = vi.hoisted(() => ({
  value: {
    workspaceId: 'w1',
    channels: [
      { id: 'c1', name: 'general', isDM: false, visibility: 'PUBLIC' },
      { id: 'c2', name: 'design', isDM: false, visibility: 'PRIVATE' },
      { id: 'c3', name: 'old', isDM: false, archivedAt: '2026-01-01' },
    ],
    dms: [
      { id: 'd1', name: 'mia', isDM: true, otherUserId: 'u2' },
      { id: 'd2', name: 'me myself', isDM: true, otherUserId: 'me' },
    ],
    unreadCounts: { c1: 3, d1: 120 } as Record<string, number>,
    onlineUsers: [{ id: 'u2' }],
    channelsLoading: false,
    dmsLoading: false,
    startCall: vi.fn(),
  },
  workspaces: { getWorkspace: (id: string) => ({ id, name: 'SmartUnifolio', isDefault: false, capabilities: { canManage: true } }) } as { getWorkspace: (id: string) => unknown } | null,
}));
vi.mock('../../pages/workspace/WorkspaceContext', () => ({ useWorkspace: () => ws.value }));
vi.mock('../../pages/workspace/WorkspacesProvider', () => ({ useWorkspaces: () => ws.workspaces, useOptionalWorkspaces: () => ws.workspaces }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', username: 'lead' } }) }));

import { CallsPage } from '../../pages/workspace/CallsPage';
import { ChatsPage } from '../../pages/workspace/ChatsPage';
import { TaskScopeSwitch } from '../tasks/TaskScopeSwitch';

const Where = () => <span data-testid="where">{useLocation().pathname}</span>;
afterEach(() => vi.clearAllMocks());

describe('MobileTabBar', () => {
  it('maps every screen to its tab', () => {
    expect(['chats', 'chat', 'dms', 'home'].map(tabForView)).toEqual(['chats', 'chats', 'chats', 'chats']);
    expect(['tasks', 'team-tasks', 'projects'].map(tabForView)).toEqual(['tasks', 'tasks', 'tasks']);
    expect(tabForView('activity')).toBe('activity');
    expect(tabForView('calls')).toBe('calls');
    expect(['more', 'directory', 'other'].map(tabForView)).toEqual(['more', 'more', 'more']);
  });

  it('marks the current tab, shows unread badges (99+) and navigates', () => {
    const onNavigate = vi.fn();
    render(<MobileTabBar activeView="team-tasks" chatsUnread={123} activityUnread={2} onNavigate={onNavigate} />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Chats, 123 unread' })).toHaveTextContent('99+');
    expect(within(nav).getByRole('button', { name: 'Activity, 2 unread' })).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole('button', { name: 'Calls' }));
    expect(onNavigate).toHaveBeenCalledWith('calls');
  });
});

describe('ChatsPage', () => {
  const renderChats = () =>
    render(
      <MemoryRouter initialEntries={['/w1/chats']}>
        <Routes>
          <Route path="/:workspaceId/*" element={<><ChatsPage /><Where /></>} />
        </Routes>
      </MemoryRouter>
    );

  it('lists channels (not archived) and DMs (not a self-DM) with unread counts and presence, and opens one', () => {
    renderChats();
    expect(screen.getByRole('button', { name: '#general, 3 unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '#design' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /#old/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'mia, 120 unread, Online' })).toHaveTextContent('99+');
    expect(screen.queryByRole('button', { name: /me myself/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '#general, 3 unread' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/w1/c/c1');
  });

  it('filters locally, and "New message" / the workspace switcher raise their events', () => {
    renderChats();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter conversations' }), { target: { value: 'des' } });
    expect(screen.getByRole('button', { name: '#design' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /#general/ })).not.toBeInTheDocument();
    const events: string[] = [];
    const listen = (e: Event) => events.push(e.type);
    window.addEventListener('smartconnect:open-palette', listen);
    window.addEventListener('smartconnect:open-navigation', listen);
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    fireEvent.click(screen.getByRole('button', { name: /Switch workspace/ }));
    expect(events).toEqual(['smartconnect:open-palette', 'smartconnect:open-navigation']);
    window.removeEventListener('smartconnect:open-palette', listen);
    window.removeEventListener('smartconnect:open-navigation', listen);
  });
});

describe('CallsPage', () => {
  it('starts audio and video calls through the existing call flow', () => {
    render(<CallsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Audio call mia' }));
    fireEvent.click(screen.getByRole('button', { name: 'Video call #general' }));
    expect(ws.value.startCall).toHaveBeenNthCalledWith(1, 'd1', 'audio');
    expect(ws.value.startCall).toHaveBeenNthCalledWith(2, 'c1', 'video');
  });
});

describe('BottomSheet', () => {
  it('is a labelled dialog that focuses its first action and closes on Escape and on the backdrop', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <BottomSheet title="Message from mia" onClose={onClose}>
        <SheetAction icon={() => null} label="Copy text" onSelect={onSelect} />
      </BottomSheet>
    );
    const dialog = screen.getByRole('dialog', { name: 'Message from mia' });
    expect(within(dialog).getByRole('button', { name: 'Copy text' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy text' }));
    expect(onSelect).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires after a touch hold, not for a mouse, not when the finger moves', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress<string>(onLongPress, 450));
    const h = result.current('m1');
    const ev = (pointerType: string, x = 10, y = 10) => ({ pointerType, clientX: x, clientY: y }) as unknown as React.PointerEvent;
    h.onPointerDown(ev('mouse'));
    act(() => vi.advanceTimersByTime(600));
    expect(onLongPress).not.toHaveBeenCalled();
    h.onPointerDown(ev('touch'));
    h.onPointerMove(ev('touch', 40, 10)); // scrolling
    act(() => vi.advanceTimersByTime(600));
    expect(onLongPress).not.toHaveBeenCalled();
    h.onPointerDown(ev('touch'));
    act(() => vi.advanceTimersByTime(460));
    expect(onLongPress).toHaveBeenCalledWith('m1');
  });
});

describe('TaskScopeSwitch', () => {
  it('shows My tasks / Team tasks to a lead only', () => {
    const { rerender } = render(<MemoryRouter><TaskScopeSwitch workspaceId="w1" current="mine" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'My tasks' })).toHaveAttribute('aria-current', 'page');
    ws.workspaces = { getWorkspace: (id: string) => ({ id, name: 'X', isDefault: false, capabilities: { canManage: false } }) };
    rerender(<MemoryRouter><TaskScopeSwitch workspaceId="w1" current="team" /></MemoryRouter>);
    expect(screen.queryByRole('navigation', { name: 'Task lists' })).not.toBeInTheDocument();
  });
});
