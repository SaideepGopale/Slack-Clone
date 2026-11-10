import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFocusTarget, onMessageFocus } from '../../lib/messageFocus';
import { ProjectShell, ProjectsShell } from '../../pages/workspace/shells/RouteShells';
import { ChannelSearch } from './ChannelSearch';
import { Header } from './Header';
import { MoreView } from './MoreView';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } } }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const auth = { user: { id: 'me', username: 'ann', email: 'ann@example.com' } as { id: string; username: string; email?: string }, logout: vi.fn() };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../pages/workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ workspaceId: 'ws', socket: null }) }));
const workspaces = { canManageInvitations: false };
vi.mock('../../pages/workspace/WorkspacesProvider', () => ({
  useWorkspaces: () => ({ getWorkspace: () => ({ id: 'ws', capabilities: { canManage: workspaces.canManageInvitations, canManageInvitations: workspaces.canManageInvitations } }) }),
}));
const api = vi.mocked(axios, true);

const result = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  content: `<p>${content}</p>`,
  senderId: 'u1',
  sender: { id: 'u1', username: 'bob' },
  channelId: 'c1',
  createdAt: new Date().toISOString(),
  parentId: null,
  ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  auth.user = { id: 'me', username: 'ann', email: 'ann@example.com' };
  workspaces.canManageInvitations = false;
});

describe('ChannelSearch (header search, scoped to the open conversation)', () => {
  it('is disabled until a conversation is open', () => {
    render(<ChannelSearch scope={null} />);
    const box = screen.getByRole('combobox', { name: 'Search messages' });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('placeholder', 'Open a channel or conversation to search it');
  });

  it('searches the current channel on the server and focuses the chosen message', async () => {
    const focused: MessageFocusTarget[] = [];
    const stop = onMessageFocus((t) => focused.push(t));
    api.get.mockResolvedValue({ data: [result('m1', 'Deploy plan for <b>Friday</b>'), result('m2', 'deploy notes', { parentId: 'm1' })] });
    render(<ChannelSearch scope={{ id: 'c1', name: 'general', isDM: false }} />);
    const box = screen.getByRole('combobox', { name: 'Search messages in #general' });

    fireEvent.change(box, { target: { value: 'd' } }); // below the 2-character minimum
    await new Promise((r) => setTimeout(r, 400));
    expect(api.get).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: 'deploy' } });
    const list = await screen.findByRole('listbox', { name: /Messages in #general matching deploy/ });
    expect(api.get).toHaveBeenCalledWith('/api/channels/c1/search', { params: { q: 'deploy' } });
    expect(api.get).toHaveBeenCalledTimes(1); // debounced
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Deploy plan for Friday'); // HTML rendered as plain text
    expect(options[1]).toHaveTextContent('in a thread');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(focused).toEqual([{ channelId: 'c1', messageId: 'm2', parentId: 'm1' }]);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    stop();
  });

  it('explains empty results and channels the user cannot search', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    const { rerender } = render(<ChannelSearch scope={{ id: 'c1', name: 'general', isDM: false }} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nothing' } });
    expect(await screen.findByText('No messages in #general match "nothing".')).toBeInTheDocument();

    api.get.mockRejectedValueOnce({ response: { status: 403, data: { error: 'You are not a member of this channel.' } } });
    rerender(<ChannelSearch scope={{ id: 'c2', name: 'design', isDM: false }} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tokens' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Join this channel to search its messages.');
  });
});

describe('Header', () => {
  it('has no dead controls and shows Invite only to people who can invite', async () => {
    // Header lives inside the router in the app (it navigates to search results).
    const { rerender } = render(<MemoryRouter><Header searchScope={null} /></MemoryRouter>);
    expect(screen.queryByTitle('Recent activity')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Help & Support')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invite people/i })).not.toBeInTheDocument();

    workspaces.canManageInvitations = true;
    rerender(<MemoryRouter><Header searchScope={{ id: 'c1', name: 'general', isDM: false }} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /invite people/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Search messages in #general' })).toBeEnabled();

    fireEvent.click(screen.getByText('AN')); // avatar opens the profile menu
    expect(screen.getByText('ann@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/Add Birthdate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add Phone Number/)).not.toBeInTheDocument();
  });

  it('never shows a placeholder e-mail', () => {
    auth.user = { id: 'me', username: 'ann' };
    render(<MemoryRouter><Header /></MemoryRouter>);
    fireEvent.click(screen.getByText('AN'));
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
  });
});

describe('placeholders and route shells', () => {
  it('More view keeps working navigation and drops no-op items', () => {
    const onViewChange = vi.fn();
    render(<MoreView onViewChange={onViewChange} />);
    for (const gone of ['Preferences', 'Privacy & Permissions', 'Connections', 'Help Center']) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByText('Directory'));
    expect(onViewChange).toHaveBeenCalledWith('directory');
  });

  // F2 replaced the settings/organization shells with real pages (tested in
  // components/workspaceAdmin and pages/organization); F3's remain.
  it('F3 route shells render an honest not-available state', async () => {
    for (const [path, element, title] of [
      ['/ws/projects', <ProjectsShell />, 'Projects'],
      ['/ws/projects/p1', <ProjectShell />, 'Project'],
    ] as const) {
      const { unmount } = render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/:workspaceId/*" element={element} />
            <Route path="/:workspaceId/projects/:projectId" element={element} />
          </Routes>
        </MemoryRouter>
      );
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument());
      expect(screen.getByText(`${title} isn't available yet`)).toBeInTheDocument();
      unmount();
    }
  });
});
