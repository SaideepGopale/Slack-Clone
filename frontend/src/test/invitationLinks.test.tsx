import { act, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteHandler } from '../pages/auth/InviteHandler';
import { LoginPage } from '../pages/auth/LoginPage';

/**
 * P1-E — FA-SEC-04: the invitation token in a link ("/login?inviteToken=…",
 * "/invite/:token") is attacker-controlled. It used to be put into request
 * paths as-is, so "../../admin/users/<id>/ban" made a signed-in admin's
 * browser send POST /api/admin/users/<id>/ban. Only a canonical UUID may now
 * reach a request or a redirect; anything else is refused with no request.
 */

const auth = vi.hoisted(() => ({
  user: null as null | { id: string; username: string; role: 'USER' | 'ADMIN' },
  loading: false,
  login: async () => undefined,
  signup: async () => undefined,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn(), eject: vi.fn() } },
  },
}));
const api = vi.mocked(axios, true);

const TOKEN = 'c7a5b8e2-3f4d-4a1b-9c2d-8e7f6a5b4c3d';
const VICTIM = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const WS = '0b8e7a6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c';
const ADMIN = { id: 'admin-1', username: 'root', role: 'ADMIN' as const };

/** Hostile `inviteToken` query values, written as they would appear in a link. */
const HOSTILE_QUERY_VALUES = [
  `../../admin/users/${VICTIM}/ban`,
  `..%2F..%2Fadmin%2Fusers%2F${VICTIM}%2Fban`, // percent-encoded in the link
  `%2e%2e%2f%2e%2e%2fadmin%2fusers%2f${VICTIM}%2fban`, // fully encoded
  `.%252e/%252E./admin/users/${VICTIM}/ban`, // mixed: reaches the page as ".%2e/%2E./…"
  `../../workspaces/${WS}/leave`, // a non-admin forged action
  `${TOKEN}/../../admin/users/${VICTIM}/ban`, // a real-looking token with a tail
  `${TOKEN}%3Fx%3D1`, // query injection ("<uuid>?x=1")
  `${TOKEN}%23frag`, // fragment injection ("<uuid>#frag")
  `${TOKEN}%26email%3Devil%40example.com`, // parameter injection
  `%20${TOKEN}`, // whitespace
  `${TOKEN}0`, // too long
  '..',
  '.',
  'abc',
];

const Where = () => {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
};

const tree = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InviteHandler />} />
      <Route path="*" element={null} />
    </Routes>
    <Where />
  </MemoryRouter>
);

const where = () => screen.getByTestId('where').textContent;
const requestedPaths = () =>
  [...api.get.mock.calls, ...api.post.mock.calls].map(([url]) => new URL(String(url), 'http://app.test').pathname);

// Neutral default responses, so an unexpected request is reported by the
// assertions below (as the path it reached) rather than crashing the page.
const neutralResponses = () => {
  api.get.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
};

beforeEach(neutralResponses);

afterEach(() => {
  vi.resetAllMocks();
  auth.user = null;
});

describe('LoginPage invitation tokens (FA-SEC-04)', () => {
  it('signed in: a valid invitation is accepted once and lands in the workspace', async () => {
    auth.user = ADMIN;
    api.post.mockResolvedValue({ data: { workspaceId: 'ws1', generalChannelId: 'ch1' } });
    render(tree(`/login?inviteToken=${TOKEN}`));
    await waitFor(() => expect(where()).toBe('/ws1/c/ch1'));
    expect(api.post.mock.calls).toEqual([[`/api/invitations/accept/${TOKEN}`]]);
  });

  it('signed in: crafted tokens are refused without any request', async () => {
    auth.user = ADMIN;
    for (const value of HOSTILE_QUERY_VALUES) {
      const { unmount } = render(tree(`/login?inviteToken=${value}`));
      await waitFor(() => expect(where(), value).not.toMatch(/^\/login/)); // the page has acted
      expect(requestedPaths(), value).toEqual([]);
      expect(where(), value).toBe('/');
      expect(toast.error).toHaveBeenCalledWith('This invitation link is invalid.');
      unmount();
      vi.resetAllMocks();
      neutralResponses();
    }
  });

  it('signed out: nothing is requested until sign-in, and then only for a valid token', async () => {
    const { rerender } = render(tree(`/login?inviteToken=../../admin/users/${VICTIM}/ban`));
    expect(screen.getByRole('button', { name: /Sign In/ })).toBeInTheDocument();
    expect(requestedPaths()).toEqual([]);
    auth.user = ADMIN; // the admin signs in on the crafted page
    await act(async () => rerender(tree(`/login?inviteToken=../../admin/users/${VICTIM}/ban`)));
    await waitFor(() => expect(where()).not.toMatch(/^\/login/));
    expect(requestedPaths()).toEqual([]);
    expect(where()).toBe('/');
  });

  it('signed out: a valid invitation is accepted right after sign-in', async () => {
    api.post.mockResolvedValue({ data: { workspaceId: 'ws1', generalChannelId: 'ch1' } });
    const { rerender } = render(tree(`/login?inviteToken=${TOKEN}`));
    expect(api.post).not.toHaveBeenCalled();
    auth.user = { id: 'u1', username: 'ann', role: 'USER' };
    await act(async () => rerender(tree(`/login?inviteToken=${TOKEN}`)));
    await waitFor(() => expect(where()).toBe('/ws1/c/ch1'));
    expect(api.post.mock.calls).toEqual([[`/api/invitations/accept/${TOKEN}`]]);
  });

  it('the join-link flow is unchanged (its token travels in the request body)', async () => {
    auth.user = { id: 'u1', username: 'ann', role: 'USER' };
    api.post.mockResolvedValue({ data: { status: 'already_member', workspaceId: 'ws1', generalChannelId: 'ch1' } });
    render(tree('/login?joinToken=link-token-123'));
    await waitFor(() => expect(where()).toBe('/ws1/c/ch1'));
    expect(api.post.mock.calls).toEqual([['/api/workspaces/join', { token: 'link-token-123' }]]);
  });
});

describe('InviteHandler invitation tokens (FA-SEC-04)', () => {
  const lookup = (isExistingUser: boolean, email = 'ann@example.com') => ({
    data: { valid: true, email, workspaceId: 'ws1', workspaceName: 'Apollo', isExistingUser },
  });

  it('signed in, existing account: looked up, accepted and lands in the workspace', async () => {
    auth.user = { id: 'u1', username: 'ann', role: 'USER' };
    api.get.mockResolvedValue(lookup(true));
    api.post.mockResolvedValue({ data: { workspaceId: 'ws1', generalChannelId: 'ch1' } });
    render(tree(`/invite/${TOKEN}`));
    await waitFor(() => expect(where()).toBe('/ws1/c/ch1'));
    expect(api.get.mock.calls).toEqual([[`/api/invitations/${TOKEN}`]]);
    expect(api.post.mock.calls).toEqual([[`/api/invitations/accept/${TOKEN}`]]);
  });

  it('signed out, existing account: redirected to login with the token intact in the query', async () => {
    api.get.mockResolvedValue(lookup(true));
    render(tree(`/invite/${TOKEN}`));
    await waitFor(() => expect(where()).toMatch(/^\/login\?/));
    const params = new URLSearchParams(where()!.split('?')[1]);
    expect([...params.keys()]).toEqual(['inviteToken']);
    expect(params.get('inviteToken')).toBe(TOKEN);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('new e-mail: redirected to signup with the token and e-mail both encoded', async () => {
    api.get.mockResolvedValue(lookup(false, 'new+person&x=1@example.com'));
    render(tree(`/invite/${TOKEN}`));
    await waitFor(() => expect(where()).toMatch(/^\/signup\?/));
    const params = new URLSearchParams(where()!.split('?')[1]);
    expect([...params.keys()]).toEqual(['inviteToken', 'email']);
    expect(params.get('inviteToken')).toBe(TOKEN);
    expect(params.get('email')).toBe('new+person&x=1@example.com');
  });

  it('crafted tokens in the invite path trigger no request and no redirect', async () => {
    auth.user = ADMIN;
    const paths = [
      `/invite/..%2F..%2Fadmin%2Fusers%2F${VICTIM}%2Fban`,
      `/invite/%2e%2e%2f%2e%2e%2fadmin%2fusers%2f${VICTIM}%2fban`,
      `/invite/${TOKEN}%2F..%2F..%2Fadmin%2Fusers%2F${VICTIM}%2Fban`,
      `/invite/${TOKEN}%3Fx%3D1`,
      `/invite/${TOKEN}%23frag`,
      `/invite/${TOKEN}%26email%3Devil%40example.com`,
      '/invite/%2e%2e',
      '/invite/abc',
    ];
    for (const path of paths) {
      const { unmount } = render(tree(path));
      await waitFor(() => expect(requestedPaths().length > 0 || where() !== path || !!screen.queryByText(/invitation link is invalid/), path).toBe(true));
      expect(requestedPaths(), path).toEqual([]);
      expect(where(), path).toBe(path);
      expect(screen.getByText('This invitation link is invalid or has expired.')).toBeInTheDocument();
      unmount();
      vi.resetAllMocks();
      neutralResponses();
    }
  });
});
