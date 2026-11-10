import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MyWorkspacesPage } from '../../pages/workspace/MyWorkspacesPage';
import { AddTeamMemberModal } from './AddTeamMemberModal';
import { MemberActivationsPanel } from './MemberActivationsPanel';

/** Stage 3 (T.22) — Team Lead: add members (new or existing), member activations, My Workspaces. */

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn(), eject: vi.fn() } },
  },
}));
const api = vi.mocked(axios, true);
const h = vi.hoisted(() => ({ hierarchy: { role: 'TEAM_LEAD', canCreateWorkspaces: true, canProvisionMembers: true } as Record<string, unknown> | null, workspaces: [] as unknown[] }));
vi.mock('../../hooks/useHierarchy', () => ({ useHierarchy: () => h.hierarchy }));
vi.mock('../../pages/workspace/WorkspacesProvider', () => ({ useWorkspaces: () => ({ workspaces: h.workspaces, loading: false, refresh: vi.fn() }) }));
vi.mock('../sidebar/CreateWorkspaceModal', () => ({ CreateWorkspaceModal: () => <div role="dialog" aria-label="Create a workspace" /> }));

const CREDENTIALS = {
  loginId: 'mia@acme.io',
  temporaryPassword: 'Kp7Qm-3xTzR-hW9aB-c4NvE',
  activationUrl: 'http://localhost:5174/activate#token=abcDEF_ghi-0123456789abcdefghijklmnopqrstuv',
  expiresAt: '2026-11-14T00:00:00.000Z',
};
const invitation = (id: string, name: string, status: string, accountStatus = 'SUSPENDED') => ({
  id, status, teamLabel: null, expiresAt: '2026-11-14T00:00:00.000Z', createdAt: '2026-11-11T00:00:00.000Z',
  acceptedAt: status === 'ACCEPTED' ? '2026-11-12T00:00:00.000Z' : null, revokedAt: null, revokedReason: status === 'REVOKED' ? 'TEAM_LEAD' : null,
  account: { id: `u-${id}`, username: name.toLowerCase(), loginId: `${name.toLowerCase()}@acme.io`, displayName: name, status: accountStatus },
});

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  h.hierarchy = { role: 'TEAM_LEAD', canCreateWorkspaces: true, canProvisionMembers: true };
});
afterEach(() => vi.resetAllMocks());

describe('Add team member (Stage 3)', () => {
  it('creates a new member and hands the one-time credentials to the caller', async () => {
    const onCreated = vi.fn();
    api.post.mockResolvedValueOnce({ data: { invitation: invitation('i1', 'Mia', 'PENDING'), credentials: CREDENTIALS } });
    render(<AddTeamMemberModal workspaceId="w1" workspaceName="Design" onClose={vi.fn()} onCreated={onCreated} onAddedExisting={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Add team member' });
    fireEvent.change(within(dialog).getByLabelText(/E-mail address/), { target: { value: ' Mia@Acme.io ' } });
    fireEvent.change(within(dialog).getByLabelText(/Display name/), { target: { value: 'Mia Member' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create member' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/workspaces/w1/member-invitations', { email: 'Mia@Acme.io', displayName: 'Mia Member' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ credentials: CREDENTIALS })));
  });

  it('never duplicates an existing account: offers a direct add or the reusable invite link instead', async () => {
    const onAddedExisting = vi.fn();
    api.post.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'This person already has an account. Invite them to the workspace instead.', existingAccount: true, user: { id: 'u9', username: 'omar', displayName: 'Omar' } } },
    });
    render(<AddTeamMemberModal workspaceId="w1" workspaceName="Design" onClose={vi.fn()} onCreated={vi.fn()} onAddedExisting={onAddedExisting} />);
    const dialog = screen.getByRole('dialog', { name: 'Add team member' });
    fireEvent.change(within(dialog).getByLabelText(/E-mail address/), { target: { value: 'omar@acme.io' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create member' }));
    expect(await within(dialog).findByText(/already has an account/)).toBeInTheDocument();

    api.get.mockResolvedValueOnce({ data: { url: 'http://localhost:5174/join-workspace?token=reusable', expiresAt: '2026-11-17T00:00:00.000Z' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://localhost:5174/join-workspace?token=reusable'));

    api.post.mockResolvedValueOnce({ data: {} });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Omar to Design' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/workspaces/w1/members', { userId: 'u9' }));
    await waitFor(() => expect(onAddedExisting).toHaveBeenCalled());
  });

  it('explains a pending activation without creating anything', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'This person already has an account invitation awaiting activation.', pendingActivation: true } } });
    render(<AddTeamMemberModal workspaceId="w1" workspaceName="Design" onClose={vi.fn()} onCreated={vi.fn()} onAddedExisting={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Add team member' });
    fireEvent.change(within(dialog).getByLabelText(/E-mail address/), { target: { value: 'mia@acme.io' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create member' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('awaiting activation');
  });
});

describe('Member activations (Stage 3)', () => {
  it('lists invitation and account status, revokes pending ones and reissues expired ones (credentials shown once)', async () => {
    api.get.mockResolvedValueOnce({ data: { invitations: [invitation('i1', 'Mia', 'PENDING'), invitation('i2', 'Omar', 'ACCEPTED', 'ACTIVE'), invitation('i3', 'Lena', 'EXPIRED')] } });
    render(<MemberActivationsPanel workspaceId="w1" />);
    const row = async (name: string) => within((await screen.findByText(name)).closest('li') as HTMLElement);
    expect((await row('Mia')).getByText('Pending')).toBeInTheDocument();
    expect((await row('Mia')).getByText('Awaiting activation')).toBeInTheDocument();
    expect((await row('Omar')).getByText('Accepted')).toBeInTheDocument();
    expect((await row('Omar')).getByText('Active')).toBeInTheDocument();
    expect((await row('Lena')).getByText('Expired')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/workspaces/w1/member-invitations');

    api.post.mockResolvedValueOnce({ data: { invitation: { ...invitation('i1', 'Mia', 'REVOKED') } } });
    fireEvent.click((await row('Mia')).getByRole('button', { name: 'Revoke invitation for Mia' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/workspaces/w1/member-invitations/i1/revoke', undefined));
    expect(await (await row('Mia')).findByText('Revoked')).toBeInTheDocument();

    api.post.mockResolvedValueOnce({ data: { invitation: invitation('i4', 'Lena', 'PENDING'), credentials: CREDENTIALS } });
    fireEvent.click((await row('Lena')).getByRole('button', { name: 'Reissue invitation for Lena' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/workspaces/w1/member-invitations/i3/reissue', undefined));
    const shown = await screen.findByRole('dialog', { name: 'Member invitation' });
    expect(within(shown).getByText(CREDENTIALS.temporaryPassword)).toBeInTheDocument();
    expect((await row('Omar')).queryByRole('button', { name: /Revoke|Reissue/ })).not.toBeInTheDocument();
  });
});

describe('My Workspaces (Stage 3)', () => {
  const ws = (id: string, extra: Record<string, unknown>) => ({ id, name: id, ownerId: 'x', capabilities: { canManage: true }, _count: { members: 3, channels: 2 }, ...extra });

  it('shows the workspaces a Team Lead runs, with member counts, and offers Create Workspace', () => {
    h.workspaces = [
      ws('Collab', { isDefault: true, capabilities: { canManage: false } }),
      ws('Design', { isOwner: true, description: 'Design team', _count: { members: 4, channels: 3 } }),
      ws('Guest', { capabilities: { canManage: false } }),
    ];
    render(<MemoryRouter initialEntries={['/w0/my-workspaces']}><MyWorkspacesPage /></MemoryRouter>);
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByText('Design')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Design team')).toBeInTheDocument();
    expect(within(cards[0]).getByText('4 members')).toBeInTheDocument();
    expect(within(cards[0]).getByRole('link', { name: 'Manage Design' })).toHaveAttribute('href', '/Design/settings?tab=members');
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(screen.getByRole('dialog', { name: 'Create a workspace' })).toBeInTheDocument();
  });

  it('offers no Create Workspace to a Member', () => {
    h.hierarchy = { role: 'MEMBER', canCreateWorkspaces: false, canProvisionMembers: false };
    h.workspaces = [ws('Collab', { isDefault: true, capabilities: { canManage: false } })];
    render(<MemoryRouter><MyWorkspacesPage /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Create workspace' })).not.toBeInTheDocument();
    expect(screen.getByText(/don't manage any team workspaces/i)).toBeInTheDocument();
  });
});
