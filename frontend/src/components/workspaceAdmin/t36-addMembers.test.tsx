import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'react-toastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeopleDirectory } from '../people/PeopleDirectory';
import { AddTeamMemberModal } from './AddTeamMemberModal';
import { InvitationsPanel } from './InvitationsPanel';

/** T.36 — adding members without e-mail: People-page entry point, visible role, honest e-mail invitations. */

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn(), eject: vi.fn() } },
  },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const api = vi.mocked(axios, true);
const h = vi.hoisted(() => ({
  hierarchy: { role: 'TEAM_LEAD', canCreateWorkspaces: true, canProvisionMembers: true } as Record<string, unknown> | null,
  workspace: null as Record<string, unknown> | null,
}));
vi.mock('../../hooks/useHierarchy', () => ({ useHierarchy: () => h.hierarchy }));
vi.mock('../../pages/workspace/WorkspacesProvider', () => ({ useWorkspaces: () => ({ getWorkspace: () => h.workspace, workspaces: [], loading: false, refresh: vi.fn() }) }));

const managedWorkspace = (overrides: Record<string, unknown> = {}) => ({
  id: 'w1',
  name: 'SmartUnifolio',
  isDefault: false,
  isOwner: true,
  capabilities: { canManage: true, canManageInvitations: true },
  ...overrides,
});

beforeEach(() => {
  h.hierarchy = { role: 'TEAM_LEAD', canCreateWorkspaces: true, canProvisionMembers: true };
  h.workspace = managedWorkspace();
  api.get.mockImplementation(async (url: string) => (url.endsWith('/members') ? { data: { members: [], nextCursor: null } } : { data: [] }));
});
afterEach(() => vi.resetAllMocks());

const renderPeople = () =>
  render(
    <MemoryRouter>
      <PeopleDirectory workspaceId="w1" currentUserId="me" onMessage={vi.fn()} />
    </MemoryRouter>
  );

describe('People page: Add member', () => {
  it('a Team Lead who manages the workspace gets "Add member", which opens the new-account dialog with the role shown as Member', async () => {
    renderPeople();
    fireEvent.click(await screen.findByRole('button', { name: 'Add member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add team member' });
    expect(within(dialog).getByLabelText('Role')).toHaveValue('Member');
    expect(within(dialog).getByLabelText('Role')).toHaveAttribute('readonly');
    expect(dialog).toHaveTextContent(/No e-mail is sent/);
  });

  it('a manager who is not a Team Lead adds existing accounts instead', async () => {
    h.hierarchy = { role: 'MEMBER', canCreateWorkspaces: false, canProvisionMembers: false };
    renderPeople();
    fireEvent.click(await screen.findByRole('button', { name: 'Add member' }));
    expect(await screen.findByRole('dialog', { name: 'Add people' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add team member' })).not.toBeInTheDocument();
  });

  it('no button for people who cannot manage members, or in SmartConnect Collab', async () => {
    h.workspace = managedWorkspace({ isOwner: false, capabilities: { canManage: false, canManageInvitations: false } });
    const { unmount } = renderPeople();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
    unmount();
    h.workspace = managedWorkspace({ isDefault: true });
    renderPeople();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
  });

  it('a created member is shown as a clear one-time result: account created, joins on activation, no e-mail', async () => {
    api.post.mockResolvedValueOnce({
      data: {
        invitation: {
          id: 'i1', status: 'PENDING', teamLabel: null, expiresAt: '2026-11-14T00:00:00.000Z', createdAt: '2026-11-11T00:00:00.000Z', acceptedAt: null, revokedAt: null, revokedReason: null,
          account: { id: 'u1', username: 'mia', loginId: 'mia@acme.io', displayName: 'Mia Chen', status: 'SUSPENDED' },
        },
        credentials: { loginId: 'mia@acme.io', temporaryPassword: 'Kp7Qm-3xTzR-hW9aB-c4NvE', activationUrl: 'http://localhost:5174/activate#token=abc', expiresAt: '2026-11-14T00:00:00.000Z' },
      },
    });
    renderPeople();
    fireEvent.click(await screen.findByRole('button', { name: 'Add member' }));
    const form = await screen.findByRole('dialog', { name: 'Add team member' });
    fireEvent.change(within(form).getByLabelText('E-mail address'), { target: { value: 'mia@acme.io' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create member' }));
    const result = await screen.findByRole('dialog', { name: 'Member invitation' });
    expect(result).toHaveTextContent('Account created for Mia Chen');
    expect(result).toHaveTextContent('They join SmartUnifolio when they activate it — no e-mail is sent');
    expect(result).toHaveTextContent('Kp7Qm-3xTzR-hW9aB-c4NvE');
    expect(api.post).toHaveBeenCalledWith('/api/workspaces/w1/member-invitations', { email: 'mia@acme.io' });
  });
});

describe('Add team member dialog', () => {
  it('shows the role as a fixed Member and never sends one', async () => {
    render(<AddTeamMemberModal workspaceId="w1" workspaceName="Design" onClose={vi.fn()} onCreated={vi.fn()} onAddedExisting={vi.fn()} />);
    expect(screen.getByLabelText('Role')).toHaveValue('Member');
    expect(screen.getByText(/Workspace admins must be Team Leads/)).toBeInTheDocument();
  });
});

describe('Invitations without e-mail delivery', () => {
  it('says up front that no e-mail can be sent, points to the no-e-mail path, and never toasts "sent"', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, emailSent: false, emailUnavailable: true, id: 'i1', token: 'tok' } });
    render(<InvitationsPanel workspaceId="w1" emailInvitationsAvailable={false} />);
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(/E-mail invitations are unavailable/);
    expect(note).toHaveTextContent(/Add team member/);
    fireEvent.change(screen.getByLabelText('E-mail address'), { target: { value: 'sam@acme.io' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/No e-mail was sent/)));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send invite' })).not.toBeInTheDocument();
  });

  it('with e-mail delivery available it is unchanged: "Send invite" and a "sent" confirmation', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, emailSent: true, id: 'i2', token: 'tok' } });
    render(<InvitationsPanel workspaceId="w1" emailInvitationsAvailable />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('E-mail address'), { target: { value: 'sam@acme.io' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Invitation sent to sam@acme.io.'));
  });
});
