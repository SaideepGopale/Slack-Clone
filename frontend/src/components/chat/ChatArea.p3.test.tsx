import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { forwardRef, ReactNode, useImperativeHandle } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Socket } from 'socket.io-client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceContext, WorkspaceContextValue } from '../../pages/workspace/WorkspaceContext';
import { Channel } from '../../types';
import { ChatArea } from './ChatArea';

/**
 * P3 — the chat area in a real render (editor included; only the virtual
 * list, emoji picker and link previews are simplified): message actions and
 * attachments are accessible, polls are keyboard-operable, the typing
 * indicator clears when the typist's message lands, and the channel actions
 * stay reachable from a compact header.
 */
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  const rects = Object.assign([rect], { item: () => rect }) as unknown as DOMRectList;
  for (const proto of [Range.prototype, Element.prototype, Text.prototype] as unknown as { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect }[]) {
    if (!proto.getClientRects) proto.getClientRects = () => rects;
    if (!proto.getBoundingClientRect) proto.getBoundingClientRect = () => rect;
  }
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

const h = vi.hoisted(() => ({
  messages: [] as unknown[],
  capabilities: {} as Record<string, boolean>,
  emits: [] as { event: string; payload: unknown }[],
  ack: { ok: true } as Record<string, unknown>,
  ackError: null as Error | null,
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(
    (
      { data, itemContent, components }: { data: { id: string }[]; itemContent: (i: number, d: unknown) => ReactNode; components?: { Header?: () => ReactNode } },
      ref
    ) => {
      useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }));
      return (
        <div>
          {components?.Header?.()}
          {data.map((d, i) => (
            <div key={d.id}>{itemContent(i, d)}</div>
          ))}
        </div>
      );
    }
  ),
}));
vi.mock('emoji-picker-react', () => ({ default: () => null, Theme: { DARK: 'dark', LIGHT: 'light' } }));
vi.mock('./LinkPreview', () => ({ LinkPreview: () => null }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', username: 'mia' } }) }));
vi.mock('axios', () => ({
  default: {
    get: async (url: string) => {
      if (url.endsWith('/messages')) return { data: { messages: h.messages, nextCursor: null, hasMore: false } };
      if (url.endsWith('/details')) {
        return {
          data: {
            id: 'c1', workspaceId: 'ws', name: 'design', visibility: 'PUBLIC', type: 'PUBLIC', isAnnouncement: false,
            archived: false, isGeneral: false, memberCount: 3, capabilities: h.capabilities,
          },
        };
      }
      if (url.endsWith('/read-receipts')) return { data: { enabled: false, receipts: [] } };
      return { data: [] };
    },
    post: async () => ({ data: {} }),
    defaults: { headers: { common: {} } },
  },
}));

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
  emit(event: string, payload?: unknown) {
    h.emits.push({ event, payload });
    return this;
  }
  timeout() {
    return {
      emit: (event: string, payload: unknown, cb?: (err: Error | null, res: unknown) => void) => {
        h.emits.push({ event, payload });
        setTimeout(() => (h.ackError ? cb?.(h.ackError, undefined) : cb?.(null, h.ack)), 0);
      },
    };
  }
  fire(event: string, payload: unknown) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }
}

const context = (socket: FakeSocket): WorkspaceContextValue =>
  ({
    workspaceId: 'ws',
    socket: socket as unknown as Socket,
    connectionStatus: 'connected',
    channels: [],
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
  }) as WorkspaceContextValue;

const channel: Channel = { id: 'c1', name: 'design', workspaceId: 'ws' } as Channel;
const msg = (over: Record<string, unknown>) => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  channelId: 'c1',
  workspaceId: 'ws',
  senderId: 'bob',
  sender: { id: 'bob', username: 'bob' },
  content: '<p>hello</p>',
  createdAt: new Date().toISOString(),
  reactions: [],
  parentId: null,
  ...over,
});

const renderChat = (socket = new FakeSocket()) => {
  const onStartCall = vi.fn();
  render(
    <WorkspaceContext.Provider value={context(socket)}>
      <MemoryRouter>
        <ChatArea channel={channel} socket={socket as unknown as Socket} onStartCall={onStartCall} />
      </MemoryRouter>
    </WorkspaceContext.Provider>
  );
  return { socket, onStartCall };
};

beforeEach(() => {
  h.messages = [];
  h.capabilities = { canRead: true, canPost: true, canReply: true, canReact: true, canLeave: true, canAddMembers: true };
  h.emits = [];
  h.ack = { ok: true };
  h.ackError = null;
  localStorage.clear();
});

describe('ChatArea (P3)', () => {
  it('gives every message action and attachment an accessible name', async () => {
    h.messages = [
      msg({ id: 'mine', senderId: 'me', sender: { id: 'me', username: 'mia' }, content: '<p>my note</p>' }),
      msg({ id: 'file', content: '', fileUrl: 'https://res.cloudinary.com/x/raw/upload/workspace-uploads/report.pdf', fileName: 'report.pdf', fileType: 'application/pdf' }),
    ];
    renderChat();
    const mine = (await screen.findByText('my note')).closest('[data-message-id]') as HTMLElement;
    for (const name of ['Add reaction', 'Pin message', 'Reply in thread', 'Edit message', 'Copy text', 'Delete message']) {
      expect(within(mine).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Download report.pdf' })).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('makes poll options real buttons and explains a failed vote in a dismissible alert', async () => {
    h.messages = [
      msg({ id: 'poll', content: '📊 Poll Created', pollData: { question: 'Lunch?', options: [{ id: 'opt-0', text: 'Pizza', votes: [] }, { id: 'opt-1', text: 'Salad', votes: ['bob'] }] } }),
    ];
    h.ack = { ok: false, error: 'Voting has closed.' };
    renderChat();
    fireEvent.click(await screen.findByRole('button', { name: /Pizza/ }));
    expect(h.emits).toContainEqual({ event: 'poll:vote', payload: { messageId: 'poll', optionId: 'opt-0' } });
    expect(await screen.findByText('Voting has closed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Voting has closed.')).not.toBeInTheDocument());
  });

  it("clears someone's typing indicator as soon as their message arrives", async () => {
    const { socket } = renderChat();
    await waitFor(() => expect(socket.handlers.get('typing:started')?.size).toBeGreaterThan(0));
    act(() => socket.fire('typing:started', { channelId: 'c1', userId: 'bob', username: 'bob' }));
    expect(await screen.findByText(/bob is typing/)).toBeInTheDocument();
    act(() => socket.fire('message:received', msg({ content: '<p>done typing</p>' })));
    await screen.findByText('done typing');
    expect(screen.queryByText(/is typing/)).not.toBeInTheDocument();
  });

  it('re-sends a message that timed out while offline as soon as the connection is back (FA-RT-08)', async () => {
    localStorage.setItem('smartconnect:draft:me:c1', JSON.stringify({ html: '<p>offline note</p>', text: 'offline note' }));
    h.ackError = new Error('operation has timed out');
    const { socket } = renderChat();
    await screen.findByText('offline note');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Not delivered yet/)).toBeInTheDocument();
    const sends = () => h.emits.filter((e) => e.event === 'message:send').map((e) => (e.payload as { clientId: string }).clientId);
    expect(sends()).toHaveLength(1);

    h.ackError = null;
    h.ack = { ok: true, message: msg({ id: 'stored', senderId: 'me', sender: { id: 'me', username: 'mia' }, content: '<p>offline note</p>', clientId: sends()[0] }) };
    act(() => socket.fire('subscriptions:ready', {}));
    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()[1]).toBe(sends()[0]); // same clientId: the server deduplicates
    await waitFor(() => expect(screen.queryByText(/Not delivered yet/)).not.toBeInTheDocument());
  });

  it('keeps calls and channel actions reachable from a compact header', async () => {
    const { onStartCall } = renderChat();
    fireEvent.click(screen.getByRole('button', { name: 'Start audio call' }));
    expect(onStartCall).toHaveBeenCalledWith('audio');
    const more = await screen.findByRole('button', { name: 'More channel actions' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Add people' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Leave channel' })).toBeInTheDocument();
  });
});
