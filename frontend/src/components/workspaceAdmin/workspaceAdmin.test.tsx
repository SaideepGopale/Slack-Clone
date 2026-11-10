import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'react-toastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBackend, FakeSocket, httpError, renderAt } from '../../test/adminHarness';
import { WorkspaceAdmin } from './WorkspaceAdmin';

vi.mock('axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
const auth = { user: { id: 'me', username: 'mia' } };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
let socket = new FakeSocket();
vi.mock('../../pages/workspace/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-cur', socket, hasActiveCall: false, endActiveCall: vi.fn() }),
}));

const caps = (all: boolean) => ({ canUpdateSettings: all, canChangeRoles: all, canRemoveMembers: all, canCreateChannel: true });
const settings = (extra: Record<string, unknown> = {}) => ({
  id: 'ws-cur',
  name: 'Apollo',
  slug: 'apollo',
  description: 'Moon program',
  isDefault: false,
  channelCreationPolicy: 'MEMBERS',
  createdAt: '2026-11-01T00:00:00Z',
  owner: { id: 'olive', username: 'olive' },
  organization: { id: 'o1', name: 'Acme', isDefault: false },
  _count: { members: 3 },
  myRole: 'MEMBER',
  organizationRole: 'MEMBER',
  capabilities: caps(false),
  ...extra,
});
const listEntry = (extra: Record<string, unknown> = {}) => ({
  id: 'ws-cur',
  name: 'Apollo',
  slug: 'apollo',
  ownerId: 'olive',
  organization: { id: 'o1', name: 'Acme', isDefault: false },
  capabilities: { canManage: false, canManageInvitations: false, canDelete: false },
  ...extra,
});
const member = (id: string, role: 'ADMIN' | 'MEMBER', isOwner = false) => ({
  id,
  username: id,
  email: `${id}@example.test`,
  title: null,
  role,
  isOwner,
  joinedAt: '2026-11-01T00:00:00Z',
  presence: null,
});

let backend: FakeBackend;
beforeEach(() => {
  vi.resetAllMocks();
  socket = new FakeSocket();
  auth.user = { id: 'me', username: 'mia' };
  backend = new FakeBackend().install();
  backend.on('GET /api/workspaces', [listEntry()]);
});

const renderAdmin = (workspaceId = 'ws-cur', path = `/ws-cur/${workspaceId === 'ws-cur' ? 'settings' : `organizations/o1/workspaces/${workspaceId}`}`) =>
  render(
    renderAt(path, workspaceId === 'ws-cur' ? '/:workspaceId/settings' : '/:workspaceId/organizations/:organizationId/workspaces/:managedWorkspaceId', (
      <WorkspaceAdmin workspaceId={workspaceId} layoutWorkspaceId="ws-cur" />
    ))
  );

describe('WorkspaceAdmin — role-based controls', () => {
  it('a plain member sees read-only settings, members, and can leave — no management tabs, no delete', async () => {
    backend.on('GET /api/workspaces/ws-cur/settings', settings());
    renderAdmin();
    expect(await screen.findByRole('heading', { level: 1, name: 'Apollo' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['General', 'Members3']);
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Only admins/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the workspace owner, workspace admins and organization admins can change these settings/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument();
  });

  it('a workspace admin edits settings (only changed fields are sent) and sees invitations/join requests, but cannot delete', async () => {
    backend.on('GET /api/workspaces', [listEntry({ capabilities: { canManage: true, canManageInvitations: true, canDelete: false } })]);
    backend.on('GET /api/workspaces/ws-cur/settings', settings({ myRole: 'ADMIN', capabilities: { ...caps(true), canChangeRoles: false } }));
    backend.on('PATCH /api/workspaces/ws-cur', (body: Record<string, unknown>) => settings({ myRole: 'ADMIN', ...body, capabilities: caps(true) }));
    renderAdmin();
    await screen.findByRole('heading', { level: 1, name: 'Apollo' });
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Members3', 'Invitations', 'Join requests']));
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Apollo 2' } });
    fireEvent.click(screen.getByRole('radio', { name: /Only admins/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(backend.called('PATCH', '/api/workspaces/ws-cur')).toHaveLength(1));
    expect(backend.called('PATCH', '/api/workspaces/ws-cur')[0].body).toEqual({ name: 'Apollo 2', channelCreationPolicy: 'ADMINS' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Apollo 2' })).toBeInTheDocument();
  });

  it('validates name length and shows server errors without losing input', async () => {
    backend.on('GET /api/workspaces/ws-cur/settings', settings({ myRole: 'OWNER', capabilities: caps(true) }));
    backend.on('PATCH /api/workspaces/ws-cur', httpError(400, 'Description must be text.'));
    renderAdmin();
    await screen.findByRole('heading', { level: 1, name: 'Apollo' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Workspace name is required.')).toBeInTheDocument();
    expect(backend.called('PATCH', '/api/workspaces/ws-cur')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Apollo X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Description must be text.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Apollo X');
  });

  it('applies live workspace:updated changes, but never overwrites an edit in progress', async () => {
    backend.on('GET /api/workspaces/ws-cur/settings', settings({ myRole: 'OWNER', capabilities: caps(true) }));
    renderAdmin();
    await screen.findByRole('heading', { level: 1, name: 'Apollo' });
    act(() => socket.emit('workspace:updated', { id: 'ws-cur', name: 'Artemis', description: 'Moon again', channelCreationPolicy: 'MEMBERS' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Artemis' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Artemis');
    // Someone else's event for another workspace is ignored.
    act(() => socket.emit('workspace:updated', { id: 'other', name: 'Nope' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Artemis');

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'My draft' } });
    act(() => socket.emit('workspace:updated', { id: 'ws-cur', name: 'Gemini', description: 'Theirs', channelCreationPolicy: 'ADMINS' }));
    expect(await screen.findByText('Someone else changed these settings while you were editing.')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('My draft');
    fireEvent.click(screen.getByRole('button', { name: 'Load their changes' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Theirs');
    expect(screen.getByLabelText('Name')).toHaveValue('Gemini');
  });

  it('refetches capabilities when MY role changes live', async () => {
    let role = 'MEMBER';
    backend.on('GET /api/workspaces/ws-cur/settings', () => settings({ myRole: role, capabilities: caps(role !== 'MEMBER') }));
    renderAdmin();
    await screen.findByRole('heading', { level: 1, name: 'Apollo' });
    expect(screen.getByLabelText('Name')).toBeDisabled();
    role = 'ADMIN';
    act(() => socket.emit('workspace:member_updated', { workspaceId: 'ws-cur', userId: 'someone-else', role: 'ADMIN' }));
    expect(backend.called('GET', '/api/workspaces/ws-cur/settings')).toHaveLength(1);
    act(() => socket.emit('workspace:member_updated', { workspaceId: 'ws-cur', userId: 'me', role: 'ADMIN' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).not.toBeDisabled());
  });
});

describe('WorkspaceAdmin — organization admin without membership', () => {
  const managed = () =>
    settings({ id: 'ws-other', name: 'Hermes', myRole: null, organizationRole: 'ADMIN', capabilities: caps(true), _count: { members: 2 } });

  it('manages and deletes the workspace without ever loading its content, then returns to the organization', async () => {
    backend.on('GET /api/workspaces/ws-other/settings', managed());
    backend.on('DELETE /api/workspaces/ws-other', { message: 'deleted' });
    renderAdmin('ws-other');
    expect(await screen.findByRole('heading', { level: 1, name: 'Hermes' })).toBeInTheDocument();
    expect(screen.getByText('Not a member')).toBeInTheDocument();
    expect(screen.getByText(/Its channels and messages are visible only to its members/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave workspace' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Members2', 'Invitations', 'Join requests']);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('OrganizationsAcmeHermes');

    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete "Hermes"?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete Workspace' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type "Hermes" to confirm'), { target: { value: 'Hermes' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/ws-cur/organizations/o1'));
    expect(backend.called('DELETE', '/api/workspaces/ws-other')).toHaveLength(1);

    // Never any content endpoint of the managed workspace.
    const contentCalls = backend.calls.filter((c) => /ws-other\/(channels|dms|unread)|\/api\/channels/.test(c.url));
    expect(contentCalls).toEqual([]);
  });

  it('shows the backend privacy answers: 404 as "not found" (existence hidden), 403 as no permission', async () => {
    backend.on('GET /api/workspaces/ws-other/settings', httpError(404, 'Workspace not found'));
    const { unmount } = renderAdmin('ws-other');
    expect(await screen.findByText('Workspace not found')).toBeInTheDocument();
    expect(screen.getByText("This workspace doesn't exist, or you don't have access to it.")).toBeInTheDocument();
    unmount();

    backend.on('GET /api/workspaces/ws-other/settings', httpError(403, 'You do not have access to this workspace'));
    renderAdmin('ws-other');
    expect(await screen.findByText("You don't have permission")).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

describe('Members tab', () => {
  const openMembers = async () => {
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /^Members/ }));
    return screen.findByRole('list', { name: 'Workspace members' });
  };

  it('the owner changes roles and removes members, never themself; live role changes are applied', async () => {
    backend.on('GET /api/workspaces/ws-cur/settings', settings({ myRole: 'OWNER', owner: { id: 'me', username: 'mia' }, capabilities: caps(true) }));
    backend.on('GET /api/workspaces/ws-cur/members', { members: [member('me', 'ADMIN', true), member('ada', 'ADMIN'), member('bob', 'MEMBER')], nextCursor: null });
    backend.on('PATCH /api/workspaces/ws-cur/members/bob', { workspaceId: 'ws-cur', userId: 'bob', role: 'ADMIN' });
    backend.on('DELETE /api/workspaces/ws-cur/members/ada', { removed: true });
    renderAdmin();
    const list = await openMembers();
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByLabelText('Role for me')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove me' })).not.toBeInTheDocument();
    expect(screen.getByText('ada@example.test', { exact: false })).toBeInTheDocument(); // managers see e-mails

    fireEvent.change(screen.getByLabelText('Role for bob'), { target: { value: 'ADMIN' } });
    await waitFor(() => expect(backend.called('PATCH', '/api/workspaces/ws-cur/members/bob')[0]?.body).toEqual({ role: 'ADMIN' }));

    act(() => socket.emit('workspace:member_updated', { workspaceId: 'ws-cur', userId: 'ada', role: 'MEMBER' }));
    expect(screen.getByLabelText('Role for ada')).toHaveValue('MEMBER');

    fireEvent.click(screen.getByRole('button', { name: 'Remove ada' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove from workspace' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(backend.called('DELETE', '/api/workspaces/ws-cur/members/ada')).toHaveLength(1);
  });

  it('a workspace admin removes plain members only and cannot change roles; a member sees no controls or e-mails', async () => {
    backend.on('GET /api/workspaces/ws-cur/settings', settings({ myRole: 'ADMIN', capabilities: { ...caps(true), canChangeRoles: false } }));
    backend.on('GET /api/workspaces/ws-cur/members', { members: [member('olive', 'ADMIN', true), member('ada', 'ADMIN'), member('bob', 'MEMBER')], nextCursor: null });
    const { unmount } = renderAdmin();
    await openMembers();
    expect(screen.queryByLabelText(/^Role for/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove ada' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove olive' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove bob' })).toBeInTheDocument();
    unmount();

    backend.on('GET /api/workspaces/ws-cur/settings', settings());
    renderAdmin();
    await openMembers();
    expect(screen.queryByLabelText(/^Role for/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByText('bob@example.test', { exact: false })).not.toBeInTheDocument();
  });
});

describe('Invitations and join requests', () => {
  const invitations = [
    { id: 'i1', email: 'pending@x.test', createdAt: '2026-11-04T00:00:00Z', expiresAt: '2026-11-18T00:00:00Z', state: 'pending', inviter: { id: 'me', username: 'mia' } },
    { id: 'i2', email: 'accepted@x.test', createdAt: '2026-11-03T00:00:00Z', expiresAt: '2026-11-17T00:00:00Z', state: 'accepted', inviter: null },
    { id: 'i3', email: 'expired@x.test', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-15T00:00:00Z', state: 'expired', inviter: null },
    { id: 'i4', email: 'revoked@x.test', createdAt: '2026-11-02T00:00:00Z', expiresAt: '2026-11-16T00:00:00Z', state: 'revoked', inviter: null },
  ];
  const asManager = () => {
    backend.on('GET /api/workspaces', [listEntry({ capabilities: { canManage: true, canManageInvitations: true, canDelete: true } })]);
    backend.on('GET /api/workspaces/ws-cur/settings', settings({ myRole: 'OWNER', capabilities: caps(true) }));
  };
  const openTab = async (name: string) => {
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(await screen.findByRole('tab', { name }));
  };

  it('lists every state, filters, revokes a pending invitation and sends e-mail invites without ever showing a token', async () => {
    asManager();
    backend.on('GET /api/workspaces/ws-cur/invitations', invitations);
    backend.on('DELETE /api/workspaces/ws-cur/invitations/i1', { id: 'i1', state: 'revoked' });
    backend.on('POST /api/workspaces/ws-cur/invites', { success: true, message: 'Invite sent successfully', token: 'tok-SECRET-123', id: 'i5' });
    renderAdmin();
    await openTab('Invitations');
    const list = await screen.findByRole('list', { name: 'Invitations' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    for (const label of ['Pending', 'Accepted', 'Expired', 'Revoked']) expect(within(list).getByText(label)).toBeInTheDocument();
    // Only pending invitations can be revoked.
    expect(within(list).getAllByRole('button', { name: /^Revoke invitation/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /^Expired/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('expired@x.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation for pending@x.test' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke invitation' }));
    await waitFor(() => expect(backend.called('DELETE', '/api/workspaces/ws-cur/invitations/i1')).toHaveLength(1));
    await waitFor(() => expect(within(list).queryAllByRole('button', { name: /^Revoke invitation/ })).toHaveLength(0));

    fireEvent.change(screen.getByLabelText('E-mail address'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText('Enter a valid e-mail address.')).toBeInTheDocument();
    expect(backend.called('POST', '/api/workspaces/ws-cur/invites')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('E-mail address'), { target: { value: 'New@x.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(backend.called('POST', '/api/workspaces/ws-cur/invites')[0]?.body).toEqual({ email: 'New@x.test' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Invitation sent to New@x.test.'));
    expect(document.body.innerHTML).not.toContain('tok-SECRET-123');
    expect(JSON.stringify(vi.mocked(toast.success).mock.calls)).not.toContain('tok-SECRET-123');
  });

  it('copies the invite link on demand and revokes all links after confirmation', async () => {
    asManager();
    backend.on('GET /api/workspaces/ws-cur/invitations', []);
    backend.on('GET /api/workspaces/ws-cur/invite-link', { url: 'http://app.test/join-workspace?token=link-1', expiresAt: '2026-11-12T00:00:00Z' });
    backend.on('DELETE /api/workspaces/ws-cur/invite-link', { revoked: 2 });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAdmin();
    await openTab('Invitations');
    expect(await screen.findByText('No invitations yet')).toBeInTheDocument();
    expect(backend.called('GET', '/api/workspaces/ws-cur/invite-link')).toHaveLength(0); // never fetched unasked

    fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://app.test/join-workspace?token=link-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all invite links' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke all links' }));
    await waitFor(() => expect(backend.called('DELETE', '/api/workspaces/ws-cur/invite-link')).toHaveLength(1));
    expect(toast.success).toHaveBeenCalledWith('2 invite links revoked.');
  });

  it('approves and rejects join requests', async () => {
    asManager();
    backend.on('GET /api/workspaces/ws-cur/requests', [
      { id: 'r1', status: 'PENDING', createdAt: '2026-11-04T00:00:00Z', user: { id: 'u1', username: 'uma', email: 'uma@x.test' } },
      { id: 'r2', status: 'PENDING', createdAt: '2026-11-04T00:00:00Z', user: { id: 'u2', username: 'vic', email: 'vic@x.test' } },
    ]);
    backend.on('PUT /api/workspaces/ws-cur/requests/r1', { status: 'APPROVED' });
    backend.on('PUT /api/workspaces/ws-cur/requests/r2', { status: 'REJECTED' });
    renderAdmin();
    await openTab('Join requests');
    const list = await screen.findByRole('list', { name: 'Join requests' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve uma' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(backend.called('PUT', '/api/workspaces/ws-cur/requests/r1')[0].body).toEqual({ action: 'APPROVE' });
    fireEvent.click(screen.getByRole('button', { name: 'Reject vic' }));
    expect(await screen.findByText('No pending join requests')).toBeInTheDocument();
    expect(backend.called('PUT', '/api/workspaces/ws-cur/requests/r2')[0].body).toEqual({ action: 'REJECT' });
  });
});
