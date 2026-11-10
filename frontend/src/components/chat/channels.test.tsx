import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composerState, isSidebarVisible } from '../../lib/channels';
import type { ChannelCapabilities, ChannelDetails } from '../../types';
import { CreateChannelModal } from '../sidebar/CreateChannelModal';
import { ChannelSettingsModal } from './ChannelSettingsModal';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const addChannel = vi.fn();
vi.mock('../../pages/workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ workspaceId: 'ws', addChannel }) }));
const api = vi.mocked(axios, true);

const none: ChannelCapabilities = {
  canRead: true,
  canPost: true,
  canReply: true,
  canReact: true,
  canJoin: false,
  canLeave: true,
  canUpdateInfo: false,
  canUpdateSettings: false,
  canChangeType: false,
  canArchive: false,
  canAddMembers: true,
  canRemoveMembers: false,
  canChangeRoles: false,
};
const owner: ChannelCapabilities = {
  ...none,
  canUpdateInfo: true,
  canUpdateSettings: true,
  canChangeType: true,
  canArchive: true,
  canRemoveMembers: true,
  canChangeRoles: true,
};

const details = (overrides: Partial<ChannelDetails> = {}): ChannelDetails => ({
  id: 'c1',
  workspaceId: 'ws',
  projectId: null,
  name: 'launch',
  description: null,
  topic: null,
  icon: 'hash',
  visibility: 'PUBLIC',
  isAnnouncement: false,
  type: 'PUBLIC',
  archived: false,
  archivedAt: null,
  isGeneral: false,
  memberCount: 3,
  owner: { id: 'me', username: 'me' },
  archivedBy: null,
  project: null,
  myRole: 'admin',
  capabilities: owner,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('channel UI rules (lib/channels)', () => {
  it('locks the composer for archived channels and for non-posters in announcement channels', () => {
    expect(composerState(null)).toEqual({ mode: 'open' });
    expect(composerState(details())).toEqual({ mode: 'open' });
    expect(composerState(details({ archived: true, capabilities: { ...owner, canPost: false } }))).toEqual({ mode: 'locked', reason: 'archived' });
    expect(composerState(details({ isAnnouncement: true, capabilities: { ...none, canPost: false } }))).toEqual({ mode: 'locked', reason: 'announcement' });
    expect(composerState(details({ capabilities: { ...none, canPost: false, canRead: false } }))).toEqual({ mode: 'locked', reason: 'not-member' });
  });

  it('hides archived channels from the sidebar unless they are open', () => {
    expect(isSidebarVisible({ id: 'a', name: 'a', archivedAt: null })).toBe(true);
    expect(isSidebarVisible({ id: 'a', name: 'a', archivedAt: '2026-11-05T00:00:00Z' })).toBe(false);
    expect(isSidebarVisible({ id: 'a', name: 'a', archivedAt: '2026-11-05T00:00:00Z' }, 'a')).toBe(true);
  });
});

describe('ChannelSettingsModal', () => {
  const members = [
    { userId: 'me', role: 'admin', joinedAt: '', user: { id: 'me', username: 'me' } },
    { userId: 'u1', role: 'member', joinedAt: '', user: { id: 'u1', username: 'alice' } },
    { userId: 'u2', role: 'moderator', joinedAt: '', user: { id: 'u2', username: 'bob' } },
  ];

  it('owners edit settings, change roles, remove members and archive', async () => {
    api.get.mockResolvedValue({ data: { members, nextCursor: null } });
    api.patch.mockResolvedValue({ data: details({ name: 'launch-2' }) });
    api.post.mockResolvedValue({ data: details({ archived: true }) });
    const onChanged = vi.fn();
    render(<ChannelSettingsModal details={details()} currentUserId="me" onClose={vi.fn()} onChanged={onChanged} />);

    fireEvent.change(screen.getByDisplayValue('launch'), { target: { value: 'launch-2' } });
    fireEvent.click(screen.getByRole('radio', { name: /Private/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/channels/c1', { name: 'launch-2', visibility: 'PRIVATE' }));
    expect(onChanged).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Archive channel/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/channels/c1/archive'));

    fireEvent.click(screen.getByRole('tab', { name: /Members/ }));
    const list = await screen.findByRole('list', { name: 'Channel members' });
    // The owner row (and your own row) never offers role or removal controls.
    expect(within(list).queryByRole('combobox', { name: 'Role of me' })).not.toBeInTheDocument();
    fireEvent.change(within(list).getByRole('combobox', { name: 'Role of alice' }), { target: { value: 'moderator' } });
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/channels/c1/members/u1', { role: 'moderator' }));
    fireEvent.click(within(list).getByRole('button', { name: 'Make bob the owner' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/channels/c1/members/u2', { role: 'admin' }));
    api.delete.mockResolvedValue({ data: {} });
    fireEvent.click(within(list).getByRole('button', { name: 'Remove alice' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/channels/c1/members/u1'));
  });

  it('plain members see read-only settings and no management controls', async () => {
    api.get.mockResolvedValue({ data: { members, nextCursor: null } });
    render(
      <ChannelSettingsModal details={details({ myRole: 'member', capabilities: none })} currentUserId="u1" onClose={vi.fn()} onChanged={vi.fn()} />
    );
    expect(screen.getByDisplayValue('launch')).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Private/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Archive channel/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Members/ }));
    const list = await screen.findByRole('list', { name: 'Channel members' });
    expect(within(list).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(within(list).getByText('Moderator')).toBeInTheDocument();
  });
});

describe('CreateChannelModal', () => {
  it('sends the chosen channel type', async () => {
    api.post.mockResolvedValue({ data: { id: 'new', name: 'secret-plans', visibility: 'PRIVATE', isAnnouncement: true } });
    render(
      <MemoryRouter>
        <CreateChannelModal isOpen onClose={vi.fn()} />
      </MemoryRouter>
    );
    fireEvent.change(screen.getByPlaceholderText('product-launch'), { target: { value: 'secret-plans' } });
    fireEvent.click(screen.getByRole('radio', { name: /Private/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Announcement channel/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Channel' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/channels', expect.objectContaining({ workspaceId: 'ws', name: 'secret-plans', visibility: 'PRIVATE', isAnnouncement: true }))
    );
    expect(addChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' }));
  });
});
