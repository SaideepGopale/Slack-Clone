import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateWorkspaceModal } from '../../components/sidebar/CreateWorkspaceModal';
import { WorkspaceSwitcher } from '../../components/sidebar/WorkspaceSwitcher';
import { FakeBackend, FakeSocket, httpError, LocationProbe, renderAt } from '../../test/adminHarness';
import { WorkspacesProvider } from '../workspace/WorkspacesProvider';
import { OrganizationPage } from './OrganizationPage';
import { OrganizationsPage } from './OrganizationsPage';

vi.mock('axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
const auth = { user: { id: 'me', username: 'mia' } };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
let socket = new FakeSocket();
vi.mock('../workspace/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-cur', socket, hasActiveCall: false, endActiveCall: vi.fn() }),
}));

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';
const capsFor = (role: Role) => ({
  canUpdate: role !== 'MEMBER',
  canCreateWorkspace: role !== 'MEMBER',
  canChangeRoles: role === 'OWNER',
  canRemoveMembers: role !== 'MEMBER',
});
const summary = (id: string, name: string, role: Role, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  slug: id,
  isDefault: false,
  myRole: role,
  capabilities: capsFor(role),
  ...extra,
});
const details = (role: Role, extra: Record<string, unknown> = {}) => ({
  ...summary('o1', 'Acme', role),
  workspaces: [
    { id: 'ws-cur', name: 'Apollo', slug: 'apollo', description: 'Current one', isDefault: false, isMember: true, myRole: role === 'OWNER' ? 'OWNER' : 'MEMBER' },
    { id: 'w2', name: 'Hermes', slug: 'hermes', description: null, isDefault: false, isMember: true, myRole: 'MEMBER' },
    ...(role === 'MEMBER' ? [] : [{ id: 'w3', name: 'Zeus', slug: 'zeus', description: null, isDefault: false, isMember: false, myRole: null }]),
  ],
  ...extra,
});
const orgMember = (id: string, role: Role, explicit = true) => ({ id, username: id, email: `${id}@example.test`, role, explicit });

let backend: FakeBackend;
beforeEach(() => {
  vi.resetAllMocks();
  socket = new FakeSocket();
  backend = new FakeBackend().install();
  backend.on('GET /api/workspaces', []);
  backend.on('GET /api/organizations', [summary('o1', 'Acme', 'OWNER'), summary('def', 'Default Organization', 'MEMBER', { isDefault: true })]);
});

const renderOrg = (path = '/ws-cur/organizations/o1') =>
  render(
    renderAt(path, '/:workspaceId/organizations/:organizationId', <OrganizationPage />, [{ path: '/:workspaceId/organizations', element: <p>organizations index</p> }])
  );

describe('OrganizationPage', () => {
  it('hides existence: a 404 renders the same "not found" as a missing organization, with no tabs', async () => {
    backend.on('GET /api/organizations/o-x', httpError(404, 'Organization not found.'));
    renderOrg('/ws-cur/organizations/o-x');
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    expect(screen.getByText("This organization doesn't exist, or you don't have access to it.")).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('owner: every workspace, manage without membership, open only where a member', async () => {
    backend.on('GET /api/organizations/o1', details('OWNER'));
    renderOrg();
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Workspaces3', 'Members', 'Settings']);
    const list = screen.getByRole('list', { name: 'Workspaces in Acme' });
    const zeus = within(list).getByText('Zeus').closest('li')!;
    expect(within(zeus).getByText('Not a member')).toBeInTheDocument();
    expect(within(zeus).queryByRole('button', { name: 'Open Zeus' })).not.toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Open Hermes' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Open Apollo' })).not.toBeInTheDocument(); // already here
    expect(screen.getByRole('button', { name: 'New workspace' })).toBeInTheDocument();

    fireEvent.click(within(zeus).getByRole('button', { name: 'Manage Zeus' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/ws-cur/organizations/o1/workspaces/w3');
  });

  it('current workspace settings link goes to the in-workspace settings page', async () => {
    backend.on('GET /api/organizations/o1', details('OWNER'));
    renderOrg();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings for Apollo' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/ws-cur/settings');
  });

  it('plain member: own workspaces only, no settings tab, no create, no member controls or e-mails', async () => {
    backend.on('GET /api/organizations/o1', details('MEMBER'));
    backend.on('GET /api/organizations/o1/members', { members: [orgMember('olive', 'OWNER'), orgMember('me', 'MEMBER', false), orgMember('bob', 'MEMBER', false)], nextCursor: null });
    renderOrg();
    await screen.findByRole('heading', { level: 1, name: 'Acme' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Workspaces2', 'Members']);
    expect(screen.queryByRole('button', { name: 'New workspace' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await screen.findByRole('list', { name: 'Organization members' });
    expect(screen.queryByLabelText(/^Organization role for/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByText('bob@example.test')).not.toBeInTheDocument();
    expect(screen.getAllByText('Via workspace')).toHaveLength(2);
    expect(screen.getByText('Only the organization owner can change roles.')).toBeInTheDocument();
  });

  it('owner changes roles (ADMIN ⇄ MEMBER, never the owner) and removes members; live role events apply', async () => {
    backend.on('GET /api/organizations/o1', details('OWNER'));
    backend.on('GET /api/organizations/o1/members', { members: [orgMember('me', 'OWNER'), orgMember('ada', 'ADMIN'), orgMember('bob', 'MEMBER', false)], nextCursor: null });
    backend.on('PATCH /api/organizations/o1/members/bob', { organizationId: 'o1', userId: 'bob', role: 'ADMIN' });
    backend.on('DELETE /api/organizations/o1/members/ada', { removed: true, organizationId: 'o1', userId: 'ada', workspaces: 2 });
    renderOrg('/ws-cur/organizations/o1?tab=members');
    const list = await screen.findByRole('list', { name: 'Organization members' });
    expect(screen.queryByLabelText('Organization role for me')).not.toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Organization role for bob'), { target: { value: 'ADMIN' } });
    await waitFor(() => expect(backend.called('PATCH', '/api/organizations/o1/members/bob')[0]?.body).toEqual({ role: 'ADMIN' }));

    act(() => socket.emit('organization:member_updated', { organizationId: 'o1', userId: 'ada', role: 'MEMBER' }));
    expect(screen.getByLabelText('Organization role for ada')).toHaveValue('MEMBER');

    fireEvent.click(screen.getByRole('button', { name: 'Remove ada from organization' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('They are removed from every workspace in this organization');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from organization' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
  });

  it('organization admin (not owner): no role changes; removes members but not admins', async () => {
    backend.on('GET /api/organizations/o1', details('ADMIN'));
    backend.on('GET /api/organizations/o1/members', { members: [orgMember('olive', 'OWNER'), orgMember('me', 'ADMIN'), orgMember('ada', 'ADMIN'), orgMember('bob', 'MEMBER')], nextCursor: null });
    renderOrg('/ws-cur/organizations/o1?tab=members');
    await screen.findByRole('list', { name: 'Organization members' });
    expect(screen.queryByLabelText(/^Organization role for/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove bob from organization' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove ada from organization' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove olive from organization' })).not.toBeInTheDocument();
  });

  it('renames the organization and follows live renames, role changes and removal', async () => {
    let role: Role = 'ADMIN';
    backend.on('GET /api/organizations/o1', () => details(role));
    backend.on('PATCH /api/organizations/o1', (body: { name: string }) => ({ id: 'o1', name: body.name, slug: 'o1', isDefault: false }));
    renderOrg('/ws-cur/organizations/o1?tab=settings');
    const input = await screen.findByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Acme Labs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Labs' })).toBeInTheDocument();
    expect(backend.called('PATCH', '/api/organizations/o1')[0].body).toEqual({ name: 'Acme Labs' });
    expect(screen.getByText('Organizations can’t be deleted, and ownership can’t be transferred yet.')).toBeInTheDocument();

    act(() => socket.emit('organization:updated', { id: 'o1', name: 'Acme Global', slug: 'o1', isDefault: false }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Global' })).toBeInTheDocument();

    // Demoted live: capabilities are refetched and the Settings tab disappears.
    role = 'MEMBER';
    act(() => socket.emit('organization:member_updated', { organizationId: 'o1', userId: 'me', role: 'MEMBER' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument());

    act(() => socket.emit('organization:removed', { organizationId: 'o1' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/ws-cur\/organizations$/));
  });

  it('offers the organization switcher', async () => {
    backend.on('GET /api/organizations/o1', details('OWNER'));
    renderOrg();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch organization' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Default Organization/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/ws-cur/organizations/def');
  });
});

describe('OrganizationsPage', () => {
  it('lists my organizations and creates one (creator becomes owner)', async () => {
    backend.on('POST /api/organizations', (body: { name: string }) => ({ ...details('OWNER'), id: 'o9', name: body.name, workspaces: [] }));
    render(renderAt('/ws-cur/organizations', '/:workspaceId/organizations', <OrganizationsPage />));
    const list = await screen.findByRole('list', { name: 'Your organizations' });
    expect(within(list).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/ws-cur/organizations/o1', '/ws-cur/organizations/def']);
    fireEvent.click(screen.getByRole('button', { name: 'New organization' }));
    const dialog = screen.getByRole('dialog', { name: 'Create an organization' });
    fireEvent.change(within(dialog).getByLabelText('Organization name'), { target: { value: 'Initech' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/ws-cur/organizations/o9'));
    expect(backend.called('POST', '/api/organizations')[0].body).toEqual({ name: 'Initech' });
  });
});

describe('Organization-aware workspace creation and switching', () => {
  it('offers only organizations the server lets me create workspaces in, and sends organizationId', async () => {
    backend.on('GET /api/organizations', [summary('o1', 'Acme', 'ADMIN'), summary('o2', 'Globex', 'MEMBER')]);
    backend.on('POST /api/workspaces', (body: { name: string }) => ({ workspace: { id: 'new-ws', name: body.name, slug: 'x', ownerId: 'me' }, generalChannel: { id: 'c', name: 'General' } }));
    render(
      <MemoryRouter initialEntries={['/ws-cur']}>
        <Routes>
          <Route path="*" element={<CreateWorkspaceModal isOpen onClose={() => undefined} />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    );
    const select = await screen.findByLabelText('Organization');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['New organization', 'Acme']);
    fireEvent.change(screen.getByPlaceholderText('Acme Corp'), { target: { value: 'Rocket' } });
    fireEvent.change(select, { target: { value: 'o1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Workspace' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/new-ws'));
    expect(backend.called('POST', '/api/workspaces')[0].body).toEqual({ name: 'Rocket', organizationId: 'o1' });
  });

  it('without a choice, keeps the previous behaviour (a new organization)', async () => {
    backend.on('GET /api/organizations', [summary('o2', 'Globex', 'MEMBER')]);
    backend.on('POST /api/workspaces', { workspace: { id: 'n', name: 'Solo', slug: 'solo', ownerId: 'me' }, generalChannel: { id: 'c', name: 'General' } });
    render(
      <MemoryRouter>
        <CreateWorkspaceModal isOpen onClose={() => undefined} />
      </MemoryRouter>
    );
    await waitFor(() => expect(backend.called('GET', '/api/organizations')).toHaveLength(1));
    expect(screen.queryByLabelText('Organization')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Acme Corp'), { target: { value: 'Solo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Workspace' }));
    await waitFor(() => expect(backend.called('POST', '/api/workspaces')[0]?.body).toEqual({ name: 'Solo' }));
  });

  it('groups the workspace rail by access (P2: Collab / Mine / Shared) and links to the organization pages', async () => {
    backend.on('GET /api/workspaces', [
      { id: 'def', name: 'Lobby', slug: 'lobby', ownerId: 'x', isDefault: true, isOwner: false, organization: { id: 'od', name: 'Default Organization', isDefault: true } },
      { id: 'ws-cur', name: 'Apollo', slug: 'a', ownerId: 'me', isOwner: true, organization: { id: 'o1', name: 'Acme', isDefault: false } },
      { id: 'w2', name: 'Hermes', slug: 'h', ownerId: 'me', isOwner: true, organization: { id: 'o1', name: 'Acme', isDefault: false } },
      { id: 'w9', name: 'Solo', slug: 's', ownerId: 'other', isOwner: false, organization: { id: 'o9', name: 'Solo Org', isDefault: false } },
    ]);
    render(
      <MemoryRouter initialEntries={['/ws-cur']}>
        <WorkspacesProvider>
          <Routes>
            <Route path="/:workspaceId/*" element={<WorkspaceSwitcher />} />
          </Routes>
          <LocationProbe />
        </WorkspacesProvider>
      </MemoryRouter>
    );
    const mine = await screen.findByRole('group', { name: 'My workspaces' });
    expect(within(mine).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Apollo (current workspace)', 'Hermes']);
    // The organization is still visible on hover.
    expect(within(mine).getByRole('button', { name: 'Hermes' })).toHaveAttribute('title', 'Hermes · Acme');
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['SmartConnect Collab', 'My workspaces', 'Shared with me']);
    expect(within(screen.getByRole('group', { name: 'Shared with me' })).getByRole('button', { name: 'Solo' })).toHaveAttribute('title', 'Solo · Solo Org');
    fireEvent.click(screen.getByRole('button', { name: 'Organizations' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/ws-cur/organizations');
  });
});
