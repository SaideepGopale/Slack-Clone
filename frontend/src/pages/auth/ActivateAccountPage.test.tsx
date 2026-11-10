import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivateAccountPage } from './ActivateAccountPage';

/** Stage 2 (T.20) — the public one-time activation page. Issues no session. */

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn(), eject: vi.fn() } },
  },
}));
const api = vi.mocked(axios, true);
const TOKEN = 'abcDEF_ghi-0123456789abcdefghijklmnopqrstuv'; // 43 characters, like a real 32-byte base64url token

const Where = () => {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.hash}`}</output>;
};
const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/activate" element={<><ActivateAccountPage /><Where /></>} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>
  );
const fill = (temporary: string, password: string, confirm = password) => {
  fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: temporary } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
};
afterEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});

describe('ActivateAccountPage (Stage 2)', () => {
  it('activates with the link token, temporary password and a new password, then sends people to the normal sign-in', async () => {
    api.post.mockResolvedValueOnce({ data: { activated: true, loginId: 'nadia@acme.io' } });
    renderAt(`/activate#token=${TOKEN}`);
    // The token is taken out of the address bar straight away, and never rendered.
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/activate$/));
    expect(document.body.innerHTML).not.toContain(TOKEN);

    fill(' Kp7Qm-3xTzR-hW9aB-c4NvE ', 'a-Strong-permanent-pass-1');
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/account-activation', {
        token: TOKEN,
        temporaryPassword: 'Kp7Qm-3xTzR-hW9aB-c4NvE',
        newPassword: 'a-Strong-permanent-pass-1',
      })
    );
    expect(await screen.findByRole('heading', { name: 'Your account is ready' })).toBeInTheDocument();
    expect(screen.getByText('nadia@acme.io')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull(); // no session is created here
    fireEvent.click(screen.getByRole('link', { name: 'Go to sign in' }));
    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  it('checks the new password locally before sending anything', async () => {
    renderAt(`/activate#token=${TOKEN}`);
    fill('Kp7Qm-3xTzR-hW9aB-c4NvE', 'short');
    expect(screen.getByRole('button', { name: 'Activate account' })).toBeDisabled();
    fill('Kp7Qm-3xTzR-hW9aB-c4NvE', 'a-Strong-permanent-pass-1', 'a-Strong-permanent-pass-2');
    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate account' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("shows the server's reason when activation is refused, and lets the person try again", async () => {
    api.post.mockRejectedValueOnce({ response: { status: 400, data: { error: 'This activation link or temporary password is not valid.' } } });
    renderAt(`/activate#token=${TOKEN}`);
    fill('wrong-temporary', 'a-Strong-permanent-pass-1');
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid');
    expect(screen.getByRole('button', { name: 'Activate account' })).toBeEnabled();
  });

  it('explains an incomplete link instead of showing the form', () => {
    renderAt('/activate');
    expect(screen.getByRole('heading', { name: 'This activation link is incomplete' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Temporary password')).not.toBeInTheDocument();
  });
});
