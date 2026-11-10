import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddMemberModal } from '../chat/AddMemberModal';
import { ProfileModal } from './ProfileModal';

/**
 * P1-D — FA-SEC-03, client side: the API now leaves `email` out for viewers
 * who may not see it (only managers, and each member for themselves, get it).
 * The screens that used to show everyone's e-mail must render cleanly without
 * it — no blank line, no "undefined" — and keep showing it when it is sent.
 */

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } } }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const api = vi.mocked(axios, true);

const profile = (id: string, username: string, email?: string) => ({
  id,
  username,
  ...(email ? { email } : {}),
  title: null,
  role: 'MEMBER',
  isOwner: false,
  joinedAt: '2026-01-01T00:00:00.000Z',
  presence: null,
  bio: null,
  timezone: null,
  sharedChannels: [],
});

const openProfile = (userId: string) =>
  render(
    <ProfileModal
      workspaceId="ws"
      userId={userId}
      currentUserId="me"
      canManage={false}
      viewerIsOwner={false}
      onClose={vi.fn()}
      onMessage={vi.fn()}
      onRemoved={vi.fn()}
    />
  );

beforeEach(() => vi.resetAllMocks());

describe('ProfileModal without e-mail (FA-SEC-03)', () => {
  it('shows someone else’s profile with no e-mail line and no "undefined"', async () => {
    api.get.mockResolvedValue({ data: profile('u1', 'alice') });
    const { container } = openProfile('u1');
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/undefined|@/);
    expect(api.get).toHaveBeenCalledWith('/api/workspaces/ws/members/u1');
  });

  it('still shows an e-mail when the server sends one (your own profile, or a manager viewing)', async () => {
    api.get.mockResolvedValue({ data: profile('me', 'me', 'me@example.com') });
    openProfile('me');
    expect(await screen.findByText('me@example.com')).toBeInTheDocument();
  });
});

describe('AddMemberModal without e-mails (FA-SEC-03)', () => {
  const open = () => render(<AddMemberModal isOpen onClose={vi.fn()} channelId="c1" channelName="random" />);

  it('lists people by name, with no e-mail line and no "undefined", and searches by name', async () => {
    api.get.mockResolvedValue({ data: [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }] });
    const { container } = open();
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/undefined/);
    expect(api.get).toHaveBeenCalledWith('/api/channels/c1/addable-members');

    fireEvent.change(screen.getByPlaceholderText(/Search by name/), { target: { value: 'ali' } });
    await waitFor(() => expect(screen.queryByText('bob')).toBeNull());
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('still shows e-mails when the server sends them (workspace managers)', async () => {
    api.get.mockResolvedValue({ data: [{ id: 'u1', username: 'alice', email: 'alice@example.com' }] });
    open();
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
  });
});
