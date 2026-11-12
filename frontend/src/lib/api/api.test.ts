import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, channelsApi, errorMessage, invitationsApi, organizationsApi, projectsApi, toApiError, workspacesApi } from '.';

vi.mock('axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } },
}));
const api = vi.mocked(axios, true);

beforeEach(() => vi.resetAllMocks());

describe('typed API layer', () => {
  it('uses the default axios instance (inherits baseURL/auth) and returns response data', async () => {
    api.get.mockResolvedValue({ data: [{ id: 'ws' }] });
    await expect(workspacesApi.listWorkspaces()).resolves.toEqual([{ id: 'ws' }]);
    expect(api.get).toHaveBeenCalledWith('/api/workspaces');

    api.get.mockResolvedValue({ data: [] });
    await channelsApi.searchChannelMessages('c1', 'deploy plan');
    expect(api.get).toHaveBeenCalledWith('/api/channels/c1/search', { params: { q: 'deploy plan' } });

    api.patch.mockResolvedValue({ data: {} });
    await workspacesApi.updateWorkspaceSettings('ws', { name: 'Acme' });
    expect(api.patch).toHaveBeenCalledWith('/api/workspaces/ws', { name: 'Acme' });

    api.get.mockResolvedValue({ data: { projects: [], nextCursor: null } });
    await projectsApi.listProjects('ws', { status: 'archived' });
    expect(api.get).toHaveBeenCalledWith('/api/workspaces/ws/projects', { params: { status: 'archived' } });
  });

  it('encodes path segments', async () => {
    api.delete.mockResolvedValue({ data: {} });
    await workspacesApi.deleteWorkspace('a/b?c');
    expect(api.delete).toHaveBeenCalledWith('/api/workspaces/a%2Fb%3Fc');
  });

  it('normalizes server, HTTP and network errors into ApiError', async () => {
    api.get.mockRejectedValue({ response: { status: 403, data: { error: 'Only workspace owners and admins can manage invitations.' } } });
    const forbidden = await workspacesApi.getInviteLink('ws').catch((e: unknown) => e);
    expect(forbidden).toBeInstanceOf(ApiError);
    expect(forbidden).toMatchObject({ status: 403, message: 'Only workspace owners and admins can manage invitations.' });
    expect((forbidden as ApiError).isForbidden).toBe(true);

    api.get.mockRejectedValue({ response: { status: 500, data: '<html>' } });
    expect(await workspacesApi.listWorkspaces().catch((e: unknown) => (e as ApiError).message)).toBe('Request failed (500)');

    api.get.mockRejectedValue(new Error('socket hang up'));
    const offline = (await workspacesApi.listWorkspaces().catch((e: unknown) => e)) as ApiError;
    expect(offline.isNetwork).toBe(true);
    expect(offline.status).toBeNull();
  });

  it('errorMessage prefers the server message, then a fallback', () => {
    expect(errorMessage({ response: { data: { error: 'Nope.' } } }, 'fallback')).toBe('Nope.');
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('fallback');
    expect(errorMessage(toApiError({ response: { status: 404, data: { error: 'Project not found.' } } }))).toBe('Project not found.');
  });

  // F2: invitation tokens are single-use credentials — the API layer drops
  // them so no component can ever render or log one.
  it('never hands an invitation token (or provider error text) to callers', async () => {
    api.post.mockResolvedValue({ data: { success: true, message: 'Invite sent successfully', token: 'tok-SECRET', id: 'i1' } });
    const sent = await invitationsApi.inviteByEmail('ws 1', 'a@x.test');
    expect(sent).toEqual({ id: 'i1', emailSent: true });
    expect(api.post).toHaveBeenCalledWith('/api/workspaces/ws%201/invites', { email: 'a@x.test' });

    api.post.mockResolvedValue({ data: { success: true, token: 'tok-SECRET', id: 'i2', emailError: 'SMTP 550 internal detail' } });
    const failed = await invitationsApi.inviteByEmail('ws', 'b@x.test');
    expect(failed).toEqual({ id: 'i2', emailSent: false });
    expect(JSON.stringify([sent, failed])).not.toMatch(/tok-SECRET|SMTP/);

    api.get.mockResolvedValue({ data: [{ id: 'r1', status: 'PENDING', workspaceId: 'ws', userId: 'u1', createdAt: 'now', user: { id: 'u1', username: 'uma', email: 'u@x.test' } }] });
    expect(await invitationsApi.listJoinRequests('ws')).toEqual([{ id: 'r1', createdAt: 'now', user: { id: 'u1', username: 'uma', email: 'u@x.test' } }]);
  });

  // T.36: with no e-mail provider the server saves the invitation but sends
  // nothing; the caller must not be told it was sent.
  it('reports an invitation saved without any e-mail as not sent, and why', async () => {
    api.post.mockResolvedValue({
      data: { success: true, emailSent: false, emailUnavailable: true, message: 'Invitation saved, but no e-mail was sent.', token: 'tok-SECRET', id: 'i3' },
    });
    const saved = await invitationsApi.inviteByEmail('ws', 'c@x.test');
    expect(saved).toEqual({ id: 'i3', emailSent: false, emailUnavailable: true });
    expect(JSON.stringify(saved)).not.toMatch(/tok-SECRET/);
  });

  it('maps organization and member pages, and encodes path segments', async () => {
    api.get.mockResolvedValue({ data: { members: [{ id: 'u1' }], nextCursor: 'c2' } });
    await expect(organizationsApi.listOrganizationMembers('o/1', { q: 'ann', cursor: 'c1' })).resolves.toEqual({ items: [{ id: 'u1' }], nextCursor: 'c2' });
    expect(api.get).toHaveBeenCalledWith('/api/organizations/o%2F1/members', { params: { q: 'ann', cursor: 'c1' } });
    await workspacesApi.listWorkspaceMembers('w1');
    expect(api.get).toHaveBeenLastCalledWith('/api/workspaces/w1/members');
    api.patch.mockResolvedValue({ data: {} });
    await organizationsApi.changeOrganizationRole('o1', 'u/2', 'ADMIN');
    expect(api.patch).toHaveBeenCalledWith('/api/organizations/o1/members/u%2F2', { role: 'ADMIN' });
  });
});
