import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupWorkspacesByAccess } from '../../lib/adminAccess';
import type { Workspace } from '../../types';
import { AddMembersModal } from '../workspaceAdmin/AddMembersModal';
import { UserManagement } from './UserManagement';

/** P2 — admin provisioning UI, direct "Add people", and the access-grouped workspace rail. */

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn(), eject: vi.fn() } },
  },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 't', user: { id: 'admin-1', username: 'root', role: 'ADMIN' } }) }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => null }));
const api = vi.mocked(axios, true);

const user = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  username: `user_${id}`,
  loginId: `${id}@2003`,
  displayName: null,
  role: 'USER',
  status: 'ACTIVE',
  createdAt: '2026-11-01T00:00:00.000Z',
  workspaceCount: 1,
  ...extra,
});

beforeEach(() => {
  api.get.mockImplementation(async (url: string) => {
    if (url === '/api/admin/users') return { data: { users: [user('a1', { displayName: 'Ada Lovelace' }), user('b2', { status: 'SUSPENDED' })], nextCursor: null } };
    if (url === '/api/admin/users/a1') {
      return {
        data: {
          ...user('a1', { displayName: 'Ada Lovelace' }),
          createdBy: 'root',
          workspaces: [
            { workspaceId: 'w0', name: 'SmartConnect Collab', shared: true, role: 'MEMBER', joinedAt: '2026-11-01T00:00:00.000Z' },
            { workspaceId: 'w1', name: 'Acme Engineering', shared: false, role: 'OWNER', joinedAt: '2026-11-02T00:00:00.000Z' },
          ],
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});
afterEach(() => vi.resetAllMocks());

describe('Admin user management (P2)', () => {
  it('lists accounts from the server with display names, logins and statuses', async () => {
    render(<UserManagement />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText(/a1@2003/)).toBeInTheDocument();
    expect(screen.getByText('SUSPENDED')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/admin/users', { params: { limit: 50 } });
  });

  it('creates an account with exactly the entered credentials and confirms it', async () => {
    api.post.mockResolvedValue({ data: user('s3', { username: 'sam' }) });
    render(<UserManagement />);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: /Create user/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Create user' });
    const submit = within(dialog).getByRole('button', { name: /Create user/ });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'sam' } });
    fireEvent.change(within(dialog).getByLabelText(/Login/), { target: { value: 'sam@2003' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'sam123' } });
    fireEvent.change(within(dialog).getByLabelText(/Display name/), { target: { value: 'Sam Patel' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/admin/users', { username: 'sam', loginId: 'sam@2003', password: 'sam123', status: 'ACTIVE', displayName: 'Sam Patel' })
    );
    expect(await screen.findByText('sam was created and can sign in now.')).toBeInTheDocument();
    expect(screen.queryByText('sam123')).toBeNull(); // the password is never echoed
  });

  it('keeps Create disabled for a too-short password and shows the server error', async () => {
    api.post.mockRejectedValue({ response: { status: 409, data: { error: 'That username is already taken.' } } });
    render(<UserManagement />);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: /Create user/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Create user' });
    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'sam' } });
    fireEvent.change(within(dialog).getByLabelText(/Login/), { target: { value: 'sam@2003' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: '123' } });
    expect(within(dialog).getByRole('button', { name: /Create user/ })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: '123456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create user/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That username is already taken.');
  });

  it('shows who created an account and its workspaces, and sets a new password', async () => {
    api.post.mockResolvedValue({ data: { updated: true } });
    render(<UserManagement />);
    fireEvent.click(await screen.findByText('Ada Lovelace'));
    const dialog = await screen.findByRole('dialog', { name: 'Ada Lovelace' });
    expect(await within(dialog).findByText(/by root/)).toBeInTheDocument();
    expect(within(dialog).getByText('Acme Engineering')).toBeInTheDocument();
    expect(within(dialog).getByText('Shared')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Set a new password'), { target: { value: 'fresh-pass' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Set password/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/admin/users/a1/password', { password: 'fresh-pass' }));
    expect(await within(dialog).findByText(/New password set/)).toBeInTheDocument();
  });
});

describe('Add people (P2)', () => {
  it('searches registered accounts and adds one directly', async () => {
    api.get.mockResolvedValue({ data: { users: [{ id: 'u9', username: 'bee', displayName: 'Bee Kay' }] } });
    api.post.mockResolvedValue({ data: { id: 'u9', username: 'bee', role: 'MEMBER' } });
    const onAdded = vi.fn();
    render(<AddMembersModal workspaceId="ws1" workspaceName="Acme" onClose={vi.fn()} onAdded={onAdded} />);
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'bee' } });
    expect(await screen.findByText('Bee Kay')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/workspaces/ws1/member-candidates', { params: { q: 'bee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add bee' }));
    expect(await screen.findByText('Added')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/workspaces/ws1/members', { userId: 'u9' });
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('shows why an add failed', async () => {
    api.get.mockResolvedValue({ data: { users: [{ id: 'u9', username: 'bee', displayName: null }] } });
    api.post.mockRejectedValue({ response: { status: 409, data: { error: 'bee is already a member of this workspace.' } } });
    render(<AddMembersModal workspaceId="ws1" workspaceName="Acme" onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'bee' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add bee' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bee is already a member of this workspace.');
  });
});

describe('workspace rail grouping (P2)', () => {
  const ws = (id: string, extra: Partial<Workspace>) => ({ id, name: id, isDefault: false, isOwner: false, ...extra }) as Workspace;

  it('orders SmartConnect Collab, then my workspaces, then those shared with me — omitting empty groups', () => {
    const groups = groupWorkspacesByAccess([ws('joined', {}), ws('collab', { isDefault: true }), ws('owned', { isOwner: true })]);
    expect(groups.map((g) => [g.label, g.workspaces.map((w) => w.id)])).toEqual([
      ['SmartConnect Collab', ['collab']],
      ['My workspaces', ['owned']],
      ['Shared with me', ['joined']],
    ]);
    expect(groupWorkspacesByAccess([ws('owned', { isOwner: true })]).map((g) => g.key)).toEqual(['mine']);
  });
});
