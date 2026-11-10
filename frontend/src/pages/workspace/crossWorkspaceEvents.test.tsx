import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceLayout } from './WorkspaceLayout';

/**
 * P3 regression (realtime audit): every conversation room the user belongs to
 * is subscribed, across ALL workspaces. A message from another workspace must
 * not trigger a DM refetch here, nor count toward this workspace's unread
 * badges.
 */
type Handler = (payload: unknown) => void;
class FakeSocket {
  handlers = new Map<string, Set<Handler>>();
  on(event: string, handler: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }
  off(event: string, handler?: Handler) {
    if (handler) this.handlers.get(event)?.delete(handler);
    return this;
  }
  emit() {
    return this;
  }
  fire(event: string, payload: unknown) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }
}

const harness = vi.hoisted(() => ({
  auth: { user: { id: 'me', username: 'mia' }, token: 'token' },
  socket: null as unknown,
  workspaces: { getWorkspace: (id: string) => ({ id, name: id }), loading: false, refresh: async () => [] },
  gets: [] as string[],
  sidebarUnread: {} as Record<string, number>,
  sidebarActivity: undefined as number | undefined,
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => harness.auth }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => harness.socket, useConnectionStatus: () => 'connected' }));
vi.mock('./WorkspacesProvider', () => ({ useWorkspaces: () => harness.workspaces, useWorkspaceLiveUpdates: () => undefined }));
vi.mock('axios', () => ({
  default: {
    get: async (url: string) => {
      harness.gets.push(url);
      if (url === '/api/workspaces/ws1/channels') return { data: [{ id: 'w1-general', name: 'General', workspaceId: 'ws1' }] };
      if (url.endsWith('/unread')) return { data: { channels: [] } };
      if (url === '/api/workspaces/ws1/notifications') return { data: { notifications: [], unreadCount: 2 } };
      return { data: [] };
    },
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    defaults: { headers: { common: {} } },
  },
}));
vi.mock('../../components/layout/Header', () => ({ Header: () => null }));
vi.mock('../../components/sidebar/WorkspaceSwitcher', () => ({ WorkspaceSwitcher: () => null }));
vi.mock('../../components/sidebar/Sidebar', () => ({
  Sidebar: ({ unreadCounts, activityUnread }: { unreadCounts: Record<string, number>; activityUnread?: number }) => {
    harness.sidebarUnread = unreadCounts;
    harness.sidebarActivity = activityUnread;
    return null;
  },
}));

const message = (over: Record<string, unknown>) => ({
  id: `m-${Math.random()}`,
  senderId: 'someone',
  createdAt: new Date().toISOString(),
  content: '<p>hi</p>',
  parentId: null,
  ...over,
});

const renderLayout = () =>
  render(
    <MemoryRouter initialEntries={['/ws1']}>
      <Routes>
        <Route path="/:workspaceId" element={<WorkspaceLayout />}>
          <Route index element={null} />
        </Route>
      </Routes>
    </MemoryRouter>
  );

describe('realtime events from other workspaces', () => {
  it("the Activity badge counts this workspace's unread mentions and replies, live", async () => {
    const socket = new FakeSocket();
    harness.socket = socket;
    renderLayout();
    await waitFor(() => expect(harness.sidebarActivity).toBe(2));
    act(() => {
      socket.fire('notification:new', { id: 'n1', workspaceId: 'ws1', isRead: false });
      socket.fire('notification:new', { id: 'n2', workspaceId: 'ws2', isRead: false });
    });
    await waitFor(() => expect(harness.sidebarActivity).toBe(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(harness.sidebarActivity).toBe(3);
  });

  it('are ignored here: no DM refetch, no unread badge', async () => {
    const socket = new FakeSocket();
    harness.socket = socket;
    render(
      <MemoryRouter initialEntries={['/ws1']}>
        <Routes>
          <Route path="/:workspaceId" element={<WorkspaceLayout />}>
            <Route index element={null} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(harness.gets).toContain('/api/workspaces/ws1/dms'));
    await waitFor(() => expect(socket.handlers.get('message:received')?.size).toBeGreaterThan(0));
    const dmFetches = () => harness.gets.filter((u) => u === '/api/workspaces/ws1/dms').length;
    const before = dmFetches();

    act(() => {
      for (let i = 0; i < 5; i++) socket.fire('message:received', message({ channelId: 'w2-general', workspaceId: 'ws2' }));
      socket.fire('message:received', message({ channelId: 'w2-general', workspaceId: 'ws2', parentId: 'p1' }));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(dmFetches()).toBe(before);
    expect(harness.sidebarUnread['w2-general']).toBeUndefined();

    // A brand-new conversation in THIS workspace (e.g. someone DMs me) still
    // loads once — not once per message.
    act(() => {
      for (let i = 0; i < 3; i++) socket.fire('message:received', message({ channelId: 'new-dm', workspaceId: 'ws1' }));
    });
    await waitFor(() => expect(dmFetches()).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(dmFetches()).toBe(before + 1);
    expect(harness.sidebarUnread['new-dm']).toBe(3);
  });
});
