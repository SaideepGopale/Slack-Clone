import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceIndex } from './WorkspaceIndex';
import { WorkspaceLayout } from './WorkspaceLayout';

/**
 * P2 regression (found by the browser E2E): switching to another workspace
 * must never redirect into a channel of the workspace you just left
 * (e.g. /<new workspace>/c/<old workspace's General>).
 */
class FakeSocket {
  on() {
    return this;
  }
  off() {
    return this;
  }
  emit() {
    return this;
  }
}

const harness = vi.hoisted(() => ({
  auth: { user: { id: 'me', username: 'mia' }, token: 'token' },
  socket: null as unknown,
  workspaces: { getWorkspace: (id: string) => ({ id, name: id }), loading: false, refresh: async () => [] },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => harness.auth }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => harness.socket, useConnectionStatus: () => 'connected' }));
vi.mock('./WorkspacesProvider', () => ({ useWorkspaces: () => harness.workspaces, useWorkspaceLiveUpdates: () => undefined }));
vi.mock('axios', () => ({
  default: {
    get: async (url: string) => {
      if (url === '/api/workspaces/ws1/channels') return { data: [{ id: 'w1-general', name: 'General' }] };
      if (url === '/api/workspaces/ws2/channels') {
        await new Promise((r) => setTimeout(r, 50)); // the new workspace's list arrives later
        return { data: [{ id: 'w2-general', name: 'General' }] };
      }
      if (url.endsWith('/unread')) return { data: { channels: [] } };
      return { data: [] };
    },
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    defaults: { headers: { common: {} } },
  },
}));
vi.mock('../../components/layout/Header', () => ({ Header: () => null }));
vi.mock('../../components/sidebar/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../../components/sidebar/WorkspaceSwitcher', () => ({ WorkspaceSwitcher: () => null }));

const visited: string[] = [];
const LocationProbe = () => {
  const location = useLocation();
  visited.push(location.pathname);
  return null;
};
const SwitchButton = () => {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/ws2')}>switch workspace</button>;
};

describe('switching workspaces', () => {
  it("lands in the new workspace's General, never a channel of the previous one", async () => {
    harness.socket = new FakeSocket();
    render(
      <MemoryRouter initialEntries={['/ws1']}>
        <Routes>
          <Route path="/:workspaceId" element={<WorkspaceLayout />}>
            <Route index element={<WorkspaceIndex />} />
            <Route path="c/:channelId" element={<SwitchButton />} />
          </Route>
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    );
    await waitFor(() => expect(visited.at(-1)).toBe('/ws1/c/w1-general'));
    fireEvent.click(await screen.findByRole('button', { name: 'switch workspace' }));
    await waitFor(() => expect(visited.at(-1)).toBe('/ws2/c/w2-general'));
    expect(visited).not.toContain('/ws2/c/w1-general');
  });
});
