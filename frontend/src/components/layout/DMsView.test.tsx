import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Channel } from '../../types';
import { DMsView } from './DMsView';

const dm = (id: string, name: string, minutesAgo: number, preview: string, senderId = 'other'): Channel => {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id,
    name,
    isDM: true,
    otherUserId: `user-${id}`,
    lastMessage: { id: `m-${id}`, preview, senderId, createdAt: at },
    lastActivityAt: at,
  };
};

const renderView = (overrides: Partial<Parameters<typeof DMsView>[0]> = {}) => {
  const props = {
    dms: [dm('1', 'alice', 30, 'older message'), dm('2', 'bob', 1, 'newest message', 'me')],
    onlineUsers: [{ id: 'user-1', username: 'alice' }],
    unreadCounts: { '1': 3 },
    currentUserId: 'me',
    onSelectChannel: vi.fn(),
    onNewConversation: vi.fn(),
    ...overrides,
  };
  render(<DMsView {...props} />);
  return props;
};

describe('DMsView', () => {
  it('lists existing conversations most-recent-first with previews (regression: list was always empty)', () => {
    renderView();
    const items = within(screen.getByRole('list', { name: /direct message conversations/i })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('bob');
    expect(items[0]).toHaveTextContent('You: newest message');
    expect(items[1]).toHaveTextContent('alice');
    expect(items[1]).toHaveTextContent('older message');
  });

  it('shows unread counts and presence', () => {
    renderView();
    const alice = screen.getByRole('button', { name: /conversation with alice, 3 unread/i });
    expect(within(alice).getByText('3')).toBeInTheDocument();
    expect(within(alice).getByRole('img', { name: 'Online' })).toBeInTheDocument();
    const bob = screen.getByRole('button', { name: /conversation with bob$/i });
    expect(within(bob).getByRole('img', { name: 'Offline' })).toBeInTheDocument();
  });

  it('filters by name or message text and opens the selected conversation', () => {
    const props = renderView();
    fireEvent.change(screen.getByRole('searchbox', { name: /search conversations/i }), { target: { value: 'ali' } });
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /conversation with alice/i }));
    expect(props.onSelectChannel).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('renders group conversations with their size and no 1:1 presence dot', () => {
    const group: Channel = {
      ...dm('3', 'Launch crew', 0, 'ship it'),
      isGroupDM: true,
      otherUserId: null,
      participants: [
        { id: 'me', username: 'me' },
        { id: 'a', username: 'a' },
        { id: 'b', username: 'b' },
      ],
    };
    renderView({ dms: [group] });
    const row = screen.getByRole('button', { name: /open group conversation launch crew/i });
    expect(within(row).getByText('3 people')).toBeInTheDocument();
    expect(within(row).queryByRole('img', { name: /online|offline/i })).not.toBeInTheDocument();
  });

  it('offers to start a conversation when there are none', () => {
    const props = renderView({ dms: [] });
    expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /find teammates/i }));
    expect(props.onNewConversation).toHaveBeenCalled();
  });
});
