import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamManagement } from './TeamManagement';

/** Stage 2 (T.20) — Admin → Team Management: list, add (credentials shown once), revoke, reissue. */

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn(), eject: vi.fn() } },
  },
}));
const api = vi.mocked(axios, true);

const invitation = (status: string, extra: Record<string, unknown> = {}) => ({
  id: `inv-${status}`,
  status,
  teamLabel: 'Design',
  expiresAt: '2026-11-13T00:00:00.000Z',
  createdAt: '2026-11-10T00:00:00.000Z',
  acceptedAt: status === 'ACCEPTED' ? '2026-11-11T00:00:00.000Z' : null,
  revokedAt: status === 'REVOKED' ? '2026-11-11T00:00:00.000Z' : null,
  revokedReason: status === 'REVOKED' ? 'ADMIN' : null,
  ...extra,
});
const lead = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  username: name.toLowerCase(),
  loginId: `${name.toLowerCase()}@acme.io`,
  displayName: name,
  status: 'ACTIVE',
  createdAt: '2026-11-10T00:00:00.000Z',
  invitation: invitation(status),
  ...extra,
});
// T.21: accounts stay SUSPENDED until activation.
const LEADS = [
  lead('u1', 'Priya', 'PENDING', { status: 'SUSPENDED' }),
  lead('u2', 'Omar', 'ACCEPTED'),
  lead('u3', 'Lena', 'EXPIRED', { status: 'SUSPENDED' }),
  lead('u4', 'Kenji', 'REVOKED', { status: 'SUSPENDED' }),
  lead('u5', 'Zara', 'ACCEPTED', { status: 'SUSPENDED' }), // activated, later suspended by an admin
];
const CREDENTIALS = {
  loginId: 'nadia@acme.io',
  temporaryPassword: 'Kp7Qm-3xTzR-hW9aB-c4NvE',
  activationUrl: 'http://localhost:5174/activate#token=abcDEF_ghi-0123456789abcdefghijklmnopqrstuvw',
  expiresAt: '2026-11-13T00:00:00.000Z',
};

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  api.get.mockResolvedValue({ data: { teamLeads: LEADS } });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('Team Management (Stage 2)', () => {
  it('lists Team Leads with their invitation status and account status', async () => {
    render(<TeamManagement />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(5);
    const row = (name: string) => within(screen.getByText(name).closest('li') as HTMLElement);
    expect(row('Priya').getByText('Pending')).toBeInTheDocument();
    expect(row('Omar').getByText('Accepted')).toBeInTheDocument();
    expect(row('Lena').getByText('Expired')).toBeInTheDocument();
    expect(row('Kenji').getByText('Revoked')).toBeInTheDocument();
    // Never activated: shown as awaiting activation, not as an admin suspension.
    for (const name of ['Priya', 'Lena', 'Kenji']) {
      expect(row(name).getByText('Awaiting activation')).toBeInTheDocument();
      expect(row(name).queryByText('Suspended')).not.toBeInTheDocument();
    }
    expect(row('Omar').getByText('Active')).toBeInTheDocument();
    expect(row('Zara').getByText('Suspended')).toBeInTheDocument();
    expect(row('Priya').getByText('priya@acme.io')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/team-management/team-leads');
  });

  it('adds a Team Lead and shows the invitation link and temporary password exactly once', async () => {
    api.post.mockResolvedValueOnce({ data: { teamLead: lead('u6', 'Nadia', 'PENDING', { status: 'SUSPENDED' }), credentials: CREDENTIALS } });
    render(<TeamManagement />);
    await screen.findByText('Priya');
    fireEvent.click(screen.getByRole('button', { name: 'Add Team Lead' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Team Lead' });
    fireEvent.change(within(dialog).getByLabelText(/E-mail address/), { target: { value: ' Nadia@Acme.io ' } });
    fireEvent.change(within(dialog).getByLabelText(/Display name/), { target: { value: 'Nadia Khan' } });
    fireEvent.change(within(dialog).getByLabelText(/Team label/), { target: { value: 'Growth' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Team Lead' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/team-management/team-leads', { email: 'Nadia@Acme.io', displayName: 'Nadia Khan', teamLabel: 'Growth' })
    );
    const shown = await screen.findByRole('dialog', { name: 'Team Lead invitation' });
    expect(within(shown).getByText(CREDENTIALS.temporaryPassword)).toBeInTheDocument();
    expect(within(shown).getByText(CREDENTIALS.activationUrl)).toBeInTheDocument();
    expect(within(shown).getByText(CREDENTIALS.loginId)).toBeInTheDocument();
    expect(within(shown).getByText(/only time/i)).toBeInTheDocument();

    fireEvent.click(within(shown).getByRole('button', { name: 'Copy invitation' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    for (const part of [CREDENTIALS.activationUrl, CREDENTIALS.temporaryPassword, CREDENTIALS.loginId]) expect(copied).toContain(part);

    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(CREDENTIALS.temporaryPassword)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(CREDENTIALS.temporaryPassword);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(CREDENTIALS.temporaryPassword);
  });

  it('shows why an add failed (for example, a duplicate e-mail) and keeps the form open', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'An account with this e-mail address already exists.' } } });
    render(<TeamManagement />);
    await screen.findByText('Priya');
    fireEvent.click(screen.getByRole('button', { name: 'Add Team Lead' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Team Lead' });
    fireEvent.change(within(dialog).getByLabelText(/E-mail address/), { target: { value: 'priya@acme.io' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Team Lead' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.queryByRole('dialog', { name: 'Team Lead invitation' })).not.toBeInTheDocument();
  });

  it('revokes a pending invitation after confirmation', async () => {
    api.post.mockResolvedValueOnce({ data: { invitation: invitation('REVOKED', { id: 'inv-PENDING' }) } });
    render(<TeamManagement />);
    const row = within((await screen.findByText('Priya')).closest('li') as HTMLElement);
    fireEvent.click(row.getByRole('button', { name: 'Revoke invitation for Priya' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/team-management/invitations/inv-PENDING/revoke', undefined));
    expect(await row.findByText('Revoked')).toBeInTheDocument();
    // Only pending invitations offer revoke.
    expect(within(screen.getByText('Omar').closest('li') as HTMLElement).queryByRole('button', { name: /Revoke invitation/ })).not.toBeInTheDocument();
  });

  it('reissues an expired invitation and shows the new credentials once', async () => {
    api.post.mockResolvedValueOnce({ data: { teamLead: lead('u3', 'Lena', 'PENDING'), credentials: { ...CREDENTIALS, loginId: 'lena@acme.io' } } });
    render(<TeamManagement />);
    const row = within((await screen.findByText('Lena')).closest('li') as HTMLElement);
    fireEvent.click(row.getByRole('button', { name: 'Reissue invitation for Lena' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/team-management/team-leads/u3/reissue', undefined));
    const shown = await screen.findByRole('dialog', { name: 'Team Lead invitation' });
    expect(within(shown).getByText(CREDENTIALS.temporaryPassword)).toBeInTheDocument();
    // Accepted invitations can't be reissued.
    expect(within(screen.getByText('Omar').closest('li') as HTMLElement).queryByRole('button', { name: /Reissue/ })).not.toBeInTheDocument();
  });
});
