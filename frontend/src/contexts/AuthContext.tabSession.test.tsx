import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T.37 — an isolated development tab (sessionStorage flag set) keeps its own
 * sign-in: it never adopts, overwrites or revokes the shared localStorage
 * token, and its logout ends only its own server-side session.
 */
const axiosMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  defaults: { headers: { common: {} as Record<string, string> } },
  interceptors: { response: { use: vi.fn(() => 1), eject: vi.fn() } },
  isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
}));
vi.mock('axios', () => ({ default: axiosMock }));

import { AuthProvider, useAuth } from './AuthContext';

const Probe = () => {
  const { user, token, loading, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : user ? `user:${user.username}` : 'signed-out'}</span>
      <span data-testid="token">{token ?? 'none'}</span>
      <button onClick={() => void login('dev1@example.test', 'pw')}>login</button>
      <button onClick={logout}>logout</button>
    </div>
  );
};

beforeEach(() => {
  localStorage.setItem('token', 'shared-tok'); // another tab's (shared) sign-in
  sessionStorage.setItem('smartconnect:dev:tab-session', '1'); // this tab is isolated
});
afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  axiosMock.defaults.headers.common = {};
});

describe('AuthProvider in an isolated development tab (T.37)', () => {
  it('starts signed out instead of adopting the shared token', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(axiosMock.get).not.toHaveBeenCalled(); // no /me with someone else's token
    expect(axiosMock.defaults.headers.common.Authorization).toBeUndefined();
  });

  it('signs in into this tab only, then logout revokes only this tab’s session', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { token: 'tab-tok', user: { id: 'u2', username: 'dev1', email: 'dev1@example.test', role: 'USER' } } });
    axiosMock.get.mockResolvedValue({ data: { id: 'u2', username: 'dev1', email: 'dev1@example.test', role: 'USER' } });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));

    act(() => screen.getByText('login').click());
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:dev1'));
    expect(sessionStorage.getItem('smartconnect:dev:tab-token')).toBe('tab-tok');
    expect(localStorage.getItem('token')).toBe('shared-tok');
    expect(axiosMock.defaults.headers.common.Authorization).toBe('Bearer tab-tok');

    axiosMock.post.mockResolvedValueOnce({ data: {} });
    act(() => screen.getByText('logout').click());
    expect(axiosMock.post).toHaveBeenLastCalledWith('/api/auth/logout', null, { headers: { Authorization: 'Bearer tab-tok' } });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
    expect(sessionStorage.getItem('smartconnect:dev:tab-token')).toBeNull();
    expect(localStorage.getItem('token')).toBe('shared-tok'); // the other tabs' sign-in is untouched
  });

  it('a 401 for this tab’s token clears only this tab', async () => {
    sessionStorage.setItem('smartconnect:dev:tab-token', 'tab-tok');
    axiosMock.get.mockRejectedValueOnce(Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401 } }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
    expect(axiosMock.get).toHaveBeenCalledWith('/api/auth/me'); // checked with this tab's token
    expect(sessionStorage.getItem('smartconnect:dev:tab-token')).toBeNull();
    expect(localStorage.getItem('token')).toBe('shared-tok');
  });
});
