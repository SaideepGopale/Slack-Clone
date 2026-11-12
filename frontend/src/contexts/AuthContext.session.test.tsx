import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T.32 — session handling (audit M17 / H1, client side):
 * - only a 401 from /api/auth/me signs the user out;
 * - network/5xx failures keep the token and expose a retryable error;
 * - logout() asks the server to end the session before clearing the tab.
 */
const axiosMock = vi.hoisted(() => {
  const mock = {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { headers: { common: {} as Record<string, string> } },
    interceptors: { response: { use: vi.fn(() => 1), eject: vi.fn() } },
    isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  };
  return mock;
});
vi.mock('axios', () => ({ default: axiosMock }));

import { AuthProvider, useAuth } from './AuthContext';

const Probe = () => {
  const { user, loading, sessionError, retrySession, logout } = useAuth();
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : user ? `user:${user.username}` : sessionError ? 'error' : 'signed-out'}</span>
      <button onClick={retrySession}>retry</button>
      <button onClick={logout}>logout</button>
    </div>
  );
};

const axiosError = (status?: number) => Object.assign(new Error('request failed'), { isAxiosError: true, response: status ? { status } : undefined });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.setItem('token', 'tok-1');
  localStorage.setItem('user', '{"stale":true}');
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('AuthContext session handling (T.32)', () => {
  it('a 401 from /me signs out', async () => {
    axiosMock.get.mockRejectedValueOnce(axiosError(401));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'));
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('a network or server error keeps the token, retries, then shows a retryable error', async () => {
    axiosMock.get.mockRejectedValue(axiosError(503));
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
    expect(axiosMock.get).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem('token')).toBe('tok-1');

    axiosMock.get.mockReset();
    axiosMock.get.mockResolvedValueOnce({ data: { id: 'u1', username: 'nadia', email: 'n@x.io', role: 'USER' } });
    act(() => screen.getByText('retry').click());
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('user:nadia'));
  });

  it('logout ends the server-side session with the current token and clears the tab', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { id: 'u1', username: 'nadia', email: 'n@x.io', role: 'USER' } });
    axiosMock.post.mockResolvedValueOnce({ data: {} });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('user:nadia'));
    // The unused stale user copy from older builds is removed.
    expect(localStorage.getItem('user')).toBeNull();

    act(() => screen.getByText('logout').click());
    expect(axiosMock.post).toHaveBeenCalledWith('/api/auth/logout', null, { headers: { Authorization: 'Bearer tok-1' } });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'));
    expect(localStorage.getItem('token')).toBeNull();
  });
});
