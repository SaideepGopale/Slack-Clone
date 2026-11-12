import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthForm } from './AuthForm';

/** T.21 — sign-up is invitation-only: the form carries ?inviteToken= to the (server-verified) sign-up. */

const auth = vi.hoisted(() => ({ login: vi.fn(), signup: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TOKEN = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

const renderAt = (url: string, presetEmail?: string) => {
  const view = render(
    <MemoryRouter initialEntries={[url]}>
      <AuthForm startOnSignup presetEmail={presetEmail} />
    </MemoryRouter>
  );
  const fill = () => {
    fireEvent.change(screen.getByPlaceholderText('Samarth Karale'), { target: { value: 'Nadia Khan' } });
    if (!presetEmail) fireEvent.change(view.container.querySelector('input[type="email"]')!, { target: { value: 'nadia@acme.io' } });
    fireEvent.change(view.container.querySelector('input[type="password"]')!, { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Account/ }));
  };
  return { fill };
};
afterEach(() => vi.clearAllMocks());

describe('AuthForm — invitation-only sign-up (T.21)', () => {
  it('sends the invitation token from the link with the sign-up', async () => {
    auth.signup.mockResolvedValueOnce(undefined);
    const { fill } = renderAt(`/signup?inviteToken=${TOKEN}&email=nadia%40acme.io`, 'nadia@acme.io');
    expect(screen.getByText('Create your account to get started.')).toBeInTheDocument();
    fill();
    await waitFor(() => expect(auth.signup).toHaveBeenCalledWith('Nadia Khan', 'nadia@acme.io', 'Password123!', TOKEN));
  });

  it('without an invitation, explains that sign-up is by invitation only (the server refuses it anyway)', async () => {
    auth.signup.mockRejectedValueOnce({ response: { data: { error: 'Sign-up is by invitation only. Open the invitation link you received to create your account.' } } });
    const { fill } = renderAt('/signup');
    expect(screen.getByText(/Sign-up is by invitation only — open the invitation link/)).toBeInTheDocument();
    fill();
    await waitFor(() => expect(auth.signup).toHaveBeenCalledWith('Nadia Khan', 'nadia@acme.io', 'Password123!', undefined));
    expect(await screen.findByText('Sign-up is by invitation only. Open the invitation link you received to create your account.')).toBeInTheDocument();
  });

  it('never forwards a malformed token', async () => {
    auth.signup.mockResolvedValueOnce(undefined);
    const { fill } = renderAt('/signup?inviteToken=..%2F..%2Fadmin');
    fill();
    await waitFor(() => expect(auth.signup).toHaveBeenCalledWith('Nadia Khan', 'nadia@acme.io', 'Password123!', undefined));
  });
});
