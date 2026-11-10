import axios, { AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import './config'; // the shared API configuration: installs the guard on the default axios instance
import { hasPathTraversal } from './pathGuard';

/**
 * P1-E — FA-SEC-04 safety net: no request through the shared (default) axios
 * instance may carry a path that the browser would rewrite with dot segments
 * ("/api/invitations/accept/../../admin/users/<id>/ban" is sent as
 * "/api/admin/users/<id>/ban"). Such requests are rejected before dispatch;
 * every other URL passes through untouched.
 */

const ID = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

// Shapes this app really sends (ids, seg()-encoded values, queries, files).
const LEGITIMATE = [
  `/api/workspaces/${ID}/members`,
  `/api/workspaces/${ID}/members?q=..%2F..%2Fadmin&limit=50`, // dots in the query are not path
  `/api/channels/${ID}/messages?before=${ID}#latest`,
  '/api/workspaces/a%2Fb/settings', // seg()-encoded value containing a slash
  `/api/admin/files/${encodeURIComponent('workspace-uploads/report.v1.pdf')}`,
  '/api/search?q=../../etc/passwd', // a user searching for a path
  '/api/uploads/file...name/...', // three dots are not a dot segment
  '/api/.well-known/thing', // a leading dot inside a name is fine
  'https://api.example.com/api/auth/me',
  'https://res.cloudinary.com/demo/raw/upload/v1/workspace-uploads/notes.txt',
  '/api/messages/x/reactions#frag/../..', // dots only in the fragment
  '',
];

const TRAVERSAL = [
  `/api/invitations/accept/../../admin/users/${ID}/ban`, // the FA-SEC-04 request
  '/api/invitations/accept/../workspaces/x/leave',
  '/api/a/./b',
  '/api/invitations/accept/..',
  '/api/invitations/accept/.',
  '/api/invitations/accept/%2e%2e/%2e%2e/admin/users/x/ban', // encoded
  '/api/invitations/accept/%2E%2e/admin', // encoded, mixed case
  '/api/invitations/accept/.%2e/%2E./admin/users/x/ban', // mixed encoding
  '/api/invitations/accept/..%2F..%2Fadmin%2Fusers%2Fx%2Fban', // hidden behind encoded slashes
  '/api/invitations/accept/%252e%252e/admin', // double-encoded
  '/api/invitations/accept/..\\..\\admin\\users\\x\\ban', // browsers treat \ as /
  '/api/invitations/accept/.\t./.\n./admin/users/x/ban', // the URL parser drops tabs/newlines
  '/api/invitations/accept/../../admin/users/x/ban?a=1#b', // with query and fragment
  'https://api.example.com/api/invitations/accept/../../admin/users/x/ban',
];

describe('hasPathTraversal (FA-SEC-04)', () => {
  it('lets every legitimate URL shape through', () => {
    for (const url of LEGITIMATE) expect(hasPathTraversal(url), url).toBe(false);
  });

  it('flags dot segments in every spelling the browser would resolve', () => {
    for (const url of TRAVERSAL) expect(hasPathTraversal(url), JSON.stringify(url)).toBe(true);
  });
});

describe('the shared axios instance (FA-SEC-04)', () => {
  const okAdapter = () =>
    vi.fn<AxiosAdapter>(async (config) => ({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config }));

  it('rejects traversal requests before they are dispatched', async () => {
    for (const url of TRAVERSAL.filter(Boolean)) {
      const adapter = okAdapter();
      await expect(axios.post(url, undefined, { adapter }), url).rejects.toMatchObject({ code: 'ERR_PATH_TRAVERSAL' });
      expect(adapter, url).not.toHaveBeenCalled();
    }
  });

  it('sends legitimate requests unchanged', async () => {
    for (const url of LEGITIMATE.filter(Boolean)) {
      const adapter = okAdapter();
      const res = await axios.get(url, { adapter, params: { cursor: '../x' } });
      expect(res.data).toEqual({ ok: true });
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(adapter.mock.calls[0][0].url, url).toBe(url); // never rewritten
    }
  });

  it('also checks a configured base URL', async () => {
    const adapter = okAdapter();
    await expect(axios.get('/api/auth/me', { adapter, baseURL: 'https://api.example.com/x/..' })).rejects.toMatchObject({ code: 'ERR_PATH_TRAVERSAL' });
    expect(adapter).not.toHaveBeenCalled();
  });
});
