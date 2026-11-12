import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyOverview } from './CompanyOverview';

/** Stage 4 (T.23) — Admin → Company → Workspace Overview (read-only). */

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn(), eject: vi.fn() } },
  },
}));
const api = vi.mocked(axios, true);

const SUMMARY = {
  totalWorkspaces: 3, activeWorkspaces: 2, totalActiveUsers: 12, totalTeamLeads: 2, totalTeamMembers: 10,
  activeMembers: 9, suspendedMembers: 1, suspendedUsers: 2, invitations: { pending: 4, accepted: 6, expired: 1, revoked: 2 },
};
const person = (id: string, name: string, level = 'MEMBER', status = 'ACTIVE') => ({ id, username: name.toLowerCase(), displayName: name, email: `${name.toLowerCase()}@acme.io`, status, level });
const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, description: `${name} team`, type: 'team', isDefault: false, owner: person('lead1', 'Priya', 'TEAM_LEAD'), teamLead: { id: 'lead1', username: 'priya', displayName: 'Priya' },
  memberCount: 5, activeMemberCount: 4, pendingInvitations: 1, status: 'active', createdAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const WORKSPACES = {
  workspaces: [row('w0', 'SmartConnect Collab', { type: 'default', isDefault: true, teamLead: null, owner: person('sys', 'System'), memberCount: 12 }), row('w1', 'Design')],
  page: 1, pageSize: 20, total: 25, totalPages: 2,
};
const DETAIL = {
  id: 'w1', name: 'Design', description: 'Design team', type: 'team', isDefault: false, createdAt: '2026-11-01T00:00:00.000Z', channelCreationPolicy: 'MEMBERS', organization: null,
  owner: person('lead1', 'Priya', 'TEAM_LEAD'), teamLead: { id: 'lead1', username: 'priya', displayName: 'Priya' }, memberCount: 3,
  members: [
    { ...person('lead1', 'Priya', 'TEAM_LEAD'), workspaceRole: 'OWNER', joinedAt: '2026-11-01T00:00:00.000Z' },
    { ...person('m1', 'Mia'), workspaceRole: 'MEMBER', joinedAt: '2026-11-02T00:00:00.000Z' },
    { ...person('m2', 'Omar', 'MEMBER', 'SUSPENDED'), workspaceRole: 'MEMBER', joinedAt: '2026-11-03T00:00:00.000Z' },
  ],
  pendingInvitations: [{ id: 'i1', createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-07T00:00:00.000Z', account: { id: 'p1', username: 'lena', displayName: 'Lena', email: 'lena@acme.io' } }],
  activity: { publicChannels: 4, privateChannels: 1, lastMessageAt: '2026-11-05T00:00:00.000Z' },
};
const LEADS = { teamLeads: [{ ...person('lead1', 'Priya', 'TEAM_LEAD'), createdAt: '2026-10-01T00:00:00.000Z', managedWorkspaces: 2, teamMembers: 7, pendingInvitations: 1 }], page: 1, pageSize: 20, total: 1, totalPages: 1 };

const respond = (url: string) => {
  if (url === '/api/company-overview/summary') return { data: SUMMARY };
  if (url === '/api/company-overview/workspaces') return { data: WORKSPACES };
  if (url === '/api/company-overview/workspaces/w1') return { data: DETAIL };
  if (url === '/api/company-overview/team-leads') return { data: LEADS };
  throw new Error(`unexpected GET ${url}`);
};
const lastParams = (url: string) => [...api.get.mock.calls].reverse().find(([u]) => u === url)?.[1]?.params ?? {};

beforeEach(() => api.get.mockImplementation(async (url: string) => respond(url)));
afterEach(() => vi.resetAllMocks());

describe('Company Workspace Overview (Stage 4)', () => {
  it('shows company metrics and every workspace, marking SmartConnect Collab as the shared default', async () => {
    render(<CompanyOverview />);
    const metrics = await screen.findByRole('region', { name: 'Company metrics' });
    for (const [label, value] of [['Total workspaces', '3'], ['Active workspaces', '2'], ['Active users', '12'], ['Team Leads', '2'], ['Team Members', '10'], ['Pending invitations', '4'], ['Suspended users', '2']]) {
      expect(within(within(metrics).getByText(label).closest('div') as HTMLElement).getByText(value)).toBeInTheDocument();
    }
    const table = await screen.findByRole('table', { name: 'Workspaces' });
    const collab = within(table).getByText('SmartConnect Collab').closest('tr') as HTMLElement;
    expect(within(collab).getByText('Shared default')).toBeInTheDocument();
    const design = within(table).getByText('Design').closest('tr') as HTMLElement;
    expect(within(design).getByText('Priya')).toBeInTheDocument();
    expect(within(design).getByText('5')).toBeInTheDocument();
    expect(within(design).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it('shows a loading state, then an error with retry', async () => {
    let fail = true;
    api.get.mockImplementation(async (url: string) => {
      if (fail && url === '/api/company-overview/summary') throw { response: { status: 500, data: { error: 'Database unavailable' } } };
      return respond(url);
    });
    render(<CompanyOverview />);
    expect(screen.getByRole('status', { name: /Loading/i })).toBeInTheDocument();
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Try again|Retry/ }));
    expect(await screen.findByRole('region', { name: 'Company metrics' })).toBeInTheDocument();
  });

  it('searches, filters and sorts through the server, and paginates', async () => {
    render(<CompanyOverview />);
    await screen.findByRole('table', { name: 'Workspaces' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search workspaces' }), { target: { value: 'design' } });
    await waitFor(() => expect(lastParams('/api/company-overview/workspaces')).toMatchObject({ q: 'design', page: 1 }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'team' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    fireEvent.change(screen.getByLabelText('Minimum members'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'members:desc' } });
    await waitFor(() =>
      expect(lastParams('/api/company-overview/workspaces')).toMatchObject({ q: 'design', type: 'team', status: 'inactive', minMembers: 3, sort: 'members', order: 'desc', page: 1 })
    );
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastParams('/api/company-overview/workspaces')).toMatchObject({ page: 2 }));
  });

  it('opens a read-only workspace detail: members, roles, statuses and pending invitations — no content', async () => {
    render(<CompanyOverview />);
    await screen.findByRole('table', { name: 'Workspaces' });
    fireEvent.click(screen.getByRole('button', { name: 'View details for Design' }));
    const dialog = await screen.findByRole('dialog', { name: 'Design' });
    expect(within(dialog).getByText(/not shown here/i)).toBeInTheDocument();
    const members = within(dialog).getByRole('list', { name: 'Members' });
    expect(within(within(members).getByText('Priya').closest('li') as HTMLElement).getByText('Owner')).toBeInTheDocument();
    expect(within(within(members).getByText('Omar').closest('li') as HTMLElement).getByText('Suspended')).toBeInTheDocument();
    expect(within(within(dialog).getByRole('list', { name: 'Pending invitations' })).getByText('Lena')).toBeInTheDocument();
    expect(within(dialog).getByText('4 public · 1 private')).toBeInTheDocument();
  });

  it('lists Team Leads and links each one to their workspaces', async () => {
    render(<CompanyOverview />);
    await screen.findByRole('table', { name: 'Workspaces' });
    fireEvent.click(screen.getByRole('tab', { name: 'Team Leads' }));
    const lead = (await screen.findByText('priya@acme.io')).closest('li') as HTMLElement;
    expect(within(lead).getByText('2 workspaces')).toBeInTheDocument();
    expect(within(lead).getByText('7 team members')).toBeInTheDocument();
    fireEvent.click(within(lead).getByRole('button', { name: 'View workspaces of Priya' }));
    await waitFor(() => expect(lastParams('/api/company-overview/workspaces')).toMatchObject({ teamLeadId: 'lead1', page: 1 }));
    expect(screen.getByRole('tab', { name: 'Workspaces' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Team Lead: Priya')).toBeInTheDocument();
  });
});
