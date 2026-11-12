import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Channel } from '../../types';
import { ChannelPage } from './ChannelPage';
import { WorkspaceContext, WorkspaceContextValue } from './WorkspaceContext';

const { mounts } = vi.hoisted(() => ({ mounts: [] as string[] }));

vi.mock('../../components/chat/ChatArea', () => ({
  ChatArea: ({ channel }: { channel: Channel }) => {
    // Records one entry per mount (not per render).
    useEffect(() => {
      mounts.push(channel.id);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <div>chat:{channel.name}</div>;
  },
}));

const baseContext = (overrides: Partial<WorkspaceContextValue>): WorkspaceContextValue => ({
  workspaceId: 'ws',
  socket: null,
  connectionStatus: 'connected',
  channels: [{ id: 'general', name: 'General' }],
  channelsLoading: false,
  dms: [],
  dmsLoading: false,
  onlineUsers: [],
  users: [],
  readState: {},
  unreadCounts: {},
  clearUnread: vi.fn(),
  markChannelRead: vi.fn(),
  fetchChannels: vi.fn(),
  fetchDMs: vi.fn(),
  upsertDM: vi.fn(),
  removeConversation: vi.fn(),
  addChannel: vi.fn(),
  startDM: vi.fn(),
  startCall: vi.fn(),
  hasActiveCall: false,
  endActiveCall: vi.fn(),
  ...overrides,
});

const renderAt = (channelId: string, ctx: WorkspaceContextValue) =>
  render(
    <WorkspaceContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[`/ws/c/${channelId}`]}>
        <Routes>
          <Route path="/:workspaceId/c/:channelId" element={<ChannelPage />} />
        </Routes>
      </MemoryRouter>
    </WorkspaceContext.Provider>
  );

describe('ChannelPage', () => {
  it('opens a DM conversation (regression: DMs rendered the "select a channel" placeholder)', () => {
    const ctx = baseContext({ dms: [{ id: 'dm-1', name: 'alice', isDM: true }] });
    renderAt('dm-1', ctx);
    expect(screen.getByText('chat:alice')).toBeInTheDocument();
    expect(ctx.clearUnread).toHaveBeenCalledWith('dm-1');
  });

  it('opens a regular channel', () => {
    renderAt('general', baseContext({}));
    expect(screen.getByText('chat:General')).toBeInTheDocument();
  });

  it('shows a loading state while conversations are still loading', () => {
    renderAt('dm-1', baseContext({ dmsLoading: true }));
    expect(screen.getByRole('status', { name: /loading conversation/i })).toBeInTheDocument();
  });

  it('remounts the chat when switching conversations, so drafts and attachments never leak (P2)', () => {
    mounts.length = 0;
    const Switch = () => {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/ws/c/random')}>switch</button>;
    };
    const ctx = baseContext({ channels: [{ id: 'general', name: 'General' }, { id: 'random', name: 'Random' }] });
    render(
      <WorkspaceContext.Provider value={ctx}>
        <MemoryRouter initialEntries={['/ws/c/general']}>
          <Routes>
            <Route path="/:workspaceId/c/:channelId" element={<><ChannelPage /><Switch /></>} />
          </Routes>
        </MemoryRouter>
      </WorkspaceContext.Provider>
    );
    expect(screen.getByText('chat:General')).toBeInTheDocument();
    fireEvent.click(screen.getByText('switch'));
    expect(screen.getByText('chat:Random')).toBeInTheDocument();
    expect(mounts).toEqual(['general', 'random']);
  });

  it('explains when a conversation is missing or inaccessible', () => {
    renderAt('nope', baseContext({}));
    expect(screen.getByText(/doesn't exist or you don't have access/i)).toBeInTheDocument();
  });
});
