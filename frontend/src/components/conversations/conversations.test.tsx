import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationDetailsModal } from './ConversationDetailsModal';
import { NewConversationModal } from './NewConversationModal';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
const api = vi.mocked(axios, true);

const member = (id: string, username: string) => ({
  id,
  username,
  email: `${username}@example.com`,
  title: null,
  role: 'MEMBER' as const,
  isOwner: false,
  joinedAt: '2026-01-01T00:00:00.000Z',
  presence: null,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('NewConversationModal', () => {
  const directory = [member('me', 'me'), member('u1', 'alice'), member('u2', 'bob')];

  it('starts a 1:1 DM when one person is chosen (and never offers yourself)', async () => {
    api.get.mockResolvedValue({ data: { members: directory, nextCursor: null } });
    const onStartDM = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewConversationModal workspaceId="ws" currentUserId="me" onClose={onClose} onStartDM={onStartDM} onGroupCreated={vi.fn()} />);

    const people = await screen.findByRole('list', { name: 'People' });
    expect(within(people).queryByText('me')).not.toBeInTheDocument();
    fireEvent.click(within(people).getByRole('button', { name: /alice/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }));

    await waitFor(() => expect(onStartDM).toHaveBeenCalledWith('u1'));
    expect(onClose).toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('creates a named group conversation for two or more people', async () => {
    api.get.mockResolvedValue({ data: { members: directory, nextCursor: null } });
    api.post.mockResolvedValue({ data: { id: 'g1', name: 'Crew', isDM: true, isGroupDM: true } });
    const onGroupCreated = vi.fn();
    render(<NewConversationModal workspaceId="ws" currentUserId="me" onClose={vi.fn()} onStartDM={vi.fn()} onGroupCreated={onGroupCreated} />);

    const people = await screen.findByRole('list', { name: 'People' });
    fireEvent.click(within(people).getByRole('button', { name: /alice/ }));
    fireEvent.click(within(people).getByRole('button', { name: /bob/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Launch crew'), { target: { value: 'Crew' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start group conversation' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/workspaces/ws/group-dms', { userIds: ['u1', 'u2'], name: 'Crew' })
    );
    expect(onGroupCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }));
  });

  it('shows server errors', async () => {
    api.get.mockResolvedValue({ data: { members: directory, nextCursor: null } });
    api.post.mockRejectedValue({ response: { data: { error: 'Everyone in a conversation must be a member of this workspace.' } } });
    render(<NewConversationModal workspaceId="ws" currentUserId="me" onClose={vi.fn()} onStartDM={vi.fn()} onGroupCreated={vi.fn()} />);
    const people = await screen.findByRole('list', { name: 'People' });
    fireEvent.click(within(people).getByRole('button', { name: /alice/ }));
    fireEvent.click(within(people).getByRole('button', { name: /bob/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start group conversation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('must be a member of this workspace');
  });
});

describe('ConversationDetailsModal', () => {
  const details = (createdBy: string) => ({
    channelId: 'g1',
    isGroupDM: true,
    createdBy,
    name: 'Crew',
    maxParticipants: 9,
    participants: [
      { id: 'me', username: 'me', joinedAt: '' },
      { id: 'u1', username: 'alice', joinedAt: '' },
      { id: 'u2', username: 'bob', joinedAt: '' },
    ],
  });
  const conversation = { id: 'g1', name: 'Crew', isDM: true, isGroupDM: true };

  it('lets the creator remove people; others only see the list', async () => {
    api.get.mockImplementation(async (url: string) =>
      url.includes('/participants') ? { data: details('me') } : { data: { members: [], nextCursor: null } }
    );
    api.delete.mockResolvedValue({ data: {} });
    const { unmount } = render(
      <ConversationDetailsModal conversation={conversation} workspaceId="ws" currentUserId="me" onlineUsers={[]} onClose={vi.fn()} onLeft={vi.fn()} />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove alice' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/channels/g1/participants/u1'));
    unmount();

    api.get.mockImplementation(async (url: string) =>
      url.includes('/participants') ? { data: details('u1') } : { data: { members: [], nextCursor: null } }
    );
    render(
      <ConversationDetailsModal conversation={conversation} workspaceId="ws" currentUserId="me" onlineUsers={[]} onClose={vi.fn()} onLeft={vi.fn()} />
    );
    await screen.findByText('3 people');
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
  });

  it('adds people with or without earlier messages, and can leave', async () => {
    api.get.mockImplementation(async (url: string) =>
      url.includes('/participants')
        ? { data: details('u1') }
        : { data: { members: [member('u3', 'carol')], nextCursor: null } }
    );
    api.post.mockResolvedValue({ data: {} });
    api.delete.mockResolvedValue({ data: {} });
    const onLeft = vi.fn();
    render(
      <ConversationDetailsModal conversation={conversation} workspaceId="ws" currentUserId="me" onlineUsers={[]} onClose={vi.fn()} onLeft={onLeft} />
    );

    const people = await screen.findByRole('list', { name: 'People' });
    fireEvent.click(within(people).getByRole('button', { name: /carol/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /share earlier messages/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/channels/g1/participants', { userId: 'u3', shareHistory: true })
    );

    fireEvent.click(screen.getByRole('button', { name: /leave conversation/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/channels/g1/participants/me'));
    expect(onLeft).toHaveBeenCalled();
  });
});
