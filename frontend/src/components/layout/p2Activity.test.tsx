import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFocusTarget, onMessageFocus, requestMessageFocusAfterNavigation, takePendingFocus } from '../../lib/messageFocus';
import { ActivityView } from './ActivityView';
import { ChannelSearch } from './ChannelSearch';

/**
 * P2 Phase I — the Activity feed (mentions + replies) and workspace-wide
 * search in the header box.
 */
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } } }));

class FakeSocket {
  handlers = new Map<string, Set<(p: unknown) => void>>();
  on(e: string, fn: (p: unknown) => void) {
    if (!this.handlers.has(e)) this.handlers.set(e, new Set());
    this.handlers.get(e)!.add(fn);
  }
  off(e: string, fn: (p: unknown) => void) {
    this.handlers.get(e)?.delete(fn);
  }
  receive(e: string, p: unknown) {
    this.handlers.get(e)?.forEach((fn) => fn(p));
  }
}
const ctx = vi.hoisted(() => ({ socket: null as unknown }));
vi.mock('../../pages/workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ workspaceId: 'ws1', socket: ctx.socket }) }));

const api = vi.mocked(axios, true);

const notification = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'MENTION',
  isRead: false,
  createdAt: new Date().toISOString(),
  workspaceId: 'ws1',
  channel: { id: 'c1', name: 'general', isDM: false, isGroupDM: false, label: 'general' },
  message: { id: `m-${id}`, parentId: null, createdAt: new Date().toISOString(), preview: `hello ${id}`, sender: { id: 'u2', username: 'bob' } },
  ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  ctx.socket = new FakeSocket();
});

describe('ActivityView (P2 Phase I)', () => {
  it('lists mentions and replies for this workspace and updates live', async () => {
    api.get.mockResolvedValue({
      data: {
        notifications: [
          notification('n1'),
          notification('n2', { type: 'REPLY', isRead: true, channel: { id: 'd1', name: null, isDM: true, isGroupDM: false, label: 'carol' } }),
        ],
        unreadCount: 1,
      },
    });
    render(<ActivityView onOpen={vi.fn()} />);
    const list = await screen.findByRole('list', { name: 'Activity' });
    expect(api.get).toHaveBeenCalledWith('/api/workspaces/ws1/notifications');
    const items = within(list).getAllByRole('button');
    expect(items[0]).toHaveTextContent('bob mentioned you in #general');
    expect(items[0]).toHaveTextContent('(unread)');
    expect(items[1]).toHaveTextContent('bob replied to your thread in carol');

    // A live notification for another workspace is ignored; this one is added.
    act(() => (ctx.socket as FakeSocket).receive('notification:new', notification('x', { workspaceId: 'other' })));
    act(() => (ctx.socket as FakeSocket).receive('notification:new', notification('n3')));
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(within(list).getAllByRole('button')[0]).toHaveTextContent('hello n3');
    expect(screen.getByRole('button', { name: 'Unread (2)' })).toBeInTheDocument();
  });

  it('opening an unread item marks it read and asks to show the message', async () => {
    api.get.mockResolvedValue({ data: { notifications: [notification('n1')], unreadCount: 1 } });
    api.post.mockResolvedValue({ data: { updated: 1 } });
    const onOpen = vi.fn();
    render(<ActivityView onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: /bob mentioned you/ }));
    expect(onOpen).toHaveBeenCalledWith({ channelId: 'c1', messageId: 'm-n1', parentId: null });
    expect(api.post).toHaveBeenCalledWith('/api/workspaces/ws1/notifications/read', { ids: ['n1'] });
    expect(screen.queryByRole('button', { name: /Mark all read/ })).not.toBeInTheDocument();
  });

  it('marks everything read and offers an empty state', async () => {
    api.get.mockResolvedValue({ data: { notifications: [notification('n1'), notification('n2')], unreadCount: 2 } });
    api.post.mockResolvedValue({ data: { updated: 2 } });
    render(<ActivityView onOpen={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Mark all read/ }));
    expect(api.post).toHaveBeenCalledWith('/api/workspaces/ws1/notifications/read', {});
    fireEvent.click(screen.getByRole('button', { name: /Unread/ }));
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });
});

describe('header search across the workspace (P2 Phase I)', () => {
  const hit = (id: string, channelId: string, label: string) => ({
    id,
    parentId: null,
    createdAt: new Date().toISOString(),
    preview: `roadmap ${id}`,
    sender: { id: 'u2', username: 'bob' },
    channel: { id: channelId, name: label, isDM: false, isGroupDM: false, label },
  });

  it('searches the whole workspace when no conversation is open, and opens matches elsewhere', async () => {
    api.get.mockResolvedValue({ data: { results: [hit('m1', 'c9', 'design')] } });
    const onOpenResult = vi.fn();
    render(<ChannelSearch scope={null} workspace={{ id: 'ws1', name: 'Apollo' }} onOpenResult={onOpenResult} />);
    const box = screen.getByRole('combobox', { name: 'Search messages in Apollo' });
    expect(box).toBeEnabled();
    fireEvent.change(box, { target: { value: 'roadmap' } });
    const option = await screen.findByRole('option');
    expect(api.get).toHaveBeenCalledWith('/api/workspaces/ws1/search', { params: { q: 'roadmap' } });
    expect(option).toHaveTextContent('in #design');
    fireEvent.click(option);
    expect(onOpenResult).toHaveBeenCalledWith({ channelId: 'c9', messageId: 'm1', parentId: null });
  });

  it('can widen a conversation search to the workspace; matches in the open one focus in place', async () => {
    api.get.mockResolvedValue({ data: { results: [hit('m2', 'c1', 'general')] } });
    const onOpenResult = vi.fn();
    const focused: MessageFocusTarget[] = [];
    const stop = onMessageFocus((t) => focused.push(t));
    render(<ChannelSearch scope={{ id: 'c1', name: 'general', isDM: false }} workspace={{ id: 'ws1', name: 'Apollo' }} onOpenResult={onOpenResult} />);
    const box = screen.getByRole('combobox', { name: 'Search messages in #general' });
    fireEvent.change(box, { target: { value: 'roadmap' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/channels/c1/search', { params: { q: 'roadmap' } }));
    fireEvent.click(screen.getByRole('button', { name: 'All of Apollo' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/workspaces/ws1/search', { params: { q: 'roadmap' } }));
    fireEvent.click(await screen.findByRole('option'));
    expect(focused).toEqual([{ channelId: 'c1', messageId: 'm2', parentId: null }]);
    expect(onOpenResult).not.toHaveBeenCalled();
    stop();
  });
});

describe('focus after navigation', () => {
  it('remembers one request until that conversation takes it', () => {
    requestMessageFocusAfterNavigation({ channelId: 'c1', messageId: 'm1' });
    expect(takePendingFocus('c2')).toBeNull();
    expect(takePendingFocus('c1')).toEqual({ channelId: 'c1', messageId: 'm1' });
    expect(takePendingFocus('c1')).toBeNull();
  });
});
