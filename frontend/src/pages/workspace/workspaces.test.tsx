import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import { ReactNode, StrictMode } from 'react';
import type { Socket } from 'socket.io-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOrganizationUpdated, applyWorkspaceUpdated, concernsUser, removeWorkspace, sortWorkspaces, upsertWorkspace } from '../../lib/workspaces';
import type { Workspace } from '../../types';
import { useWorkspaceLiveUpdates, useWorkspaces, WorkspacesProvider } from './WorkspacesProvider';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { headers: { common: {} } } } }));
const api = vi.mocked(axios, true);

const ws = (id: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name: id.toUpperCase(), slug: id, ownerId: 'o', ...extra });

/** Minimal Socket.IO stand-in: on/off/emit. */
class FakeSocket {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  on(event: string, fn: (payload: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: (payload: unknown) => void) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, payload: unknown) {
    this.handlers.get(event)?.forEach((fn) => fn(payload));
  }
  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

beforeEach(() => vi.resetAllMocks());

describe('workspace list reducers', () => {
  it('keep the Default Workspace first and apply live payloads immutably', () => {
    const list = [ws('a'), ws('def', { isDefault: true }), ws('b', { organization: { id: 'o1', name: 'Org', isDefault: false } })];
    const sorted = sortWorkspaces(list);
    expect(sorted.map((w) => w.id)).toEqual(['def', 'a', 'b']);
    expect(list.map((w) => w.id)).toEqual(['a', 'def', 'b']); // input untouched

    const renamed = applyWorkspaceUpdated(sorted, { id: 'a', name: 'Apollo', description: null });
    expect(renamed.find((w) => w.id === 'a')).toMatchObject({ name: 'Apollo', description: null });
    expect(renamed.find((w) => w.id === 'b')).toBe(sorted.find((w) => w.id === 'b'));

    expect(applyOrganizationUpdated(sorted, { id: 'o1', name: 'Org 2' }).find((w) => w.id === 'b')?.organization?.name).toBe('Org 2');
    expect(removeWorkspace(sorted, 'a').map((w) => w.id)).toEqual(['def', 'b']);
    expect(upsertWorkspace(sorted, ws('c')).map((w) => w.id)).toEqual(['def', 'a', 'b', 'c']);
    expect(upsertWorkspace(sorted, { ...ws('a'), name: 'Again' }).find((w) => w.id === 'a')?.name).toBe('Again');
    expect(concernsUser({ userId: 'me' }, 'me')).toBe(true);
    expect(concernsUser({ userId: 'you' }, 'me')).toBe(false);
    expect(concernsUser({ userId: 'me' }, undefined)).toBe(false);
  });
});

describe('WorkspacesProvider', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <WorkspacesProvider>{children}</WorkspacesProvider>;

  it('loads the list once for every consumer and exposes lookups', async () => {
    api.get.mockResolvedValue({ data: [ws('b'), ws('def', { isDefault: true })] });
    const Consumer = ({ id }: { id: string }) => {
      const { getWorkspace, loading } = useWorkspaces();
      return <p>{loading ? 'loading' : getWorkspace(id)?.name ?? 'missing'}</p>;
    };
    render(
      <WorkspacesProvider>
        <Consumer id="b" />
        <Consumer id="def" />
        <Consumer id="zzz" />
      </WorkspacesProvider>
    );
    expect(await screen.findByText('B')).toBeInTheDocument();
    expect(screen.getByText('DEF')).toBeInTheDocument();
    expect(screen.getByText('missing')).toBeInTheDocument();
    // StrictMode-safe de-duplication: concurrent refreshes share one request.
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/workspaces');
  });

  it('de-duplicates concurrent loads (StrictMode double effects, simultaneous refreshes)', async () => {
    let release!: (value: { data: Workspace[] }) => void;
    api.get.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const { result } = renderHook(() => useWorkspaces(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <WorkspacesProvider>{children}</WorkspacesProvider>
        </StrictMode>
      ),
    });
    // StrictMode mounts effects twice — still one request in flight.
    expect(api.get).toHaveBeenCalledTimes(1);
    let a!: Promise<Workspace[]>;
    let b!: Promise<Workspace[]>;
    act(() => {
      a = result.current.refresh();
      b = result.current.refresh();
    });
    expect(api.get).toHaveBeenCalledTimes(1); // joined the in-flight request
    await act(async () => release({ data: [ws('a')] }));
    await expect(a).resolves.toHaveLength(1);
    await expect(b).resolves.toHaveLength(1);
    // Once settled, a new refresh really fetches again.
    api.get.mockResolvedValueOnce({ data: [ws('a'), ws('b')] });
    await act(async () => {
      await result.current.refresh();
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(result.current.workspaces).toHaveLength(2);
  });

  it('reports a load error and recovers on refresh', async () => {
    api.get.mockRejectedValueOnce({ response: { status: 500, data: { error: 'Database unavailable' } } });
    const { result } = renderHook(() => useWorkspaces(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Database unavailable');
    api.get.mockResolvedValueOnce({ data: [ws('a')] });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.workspaces.map((w) => w.id)).toEqual(['a']);
  });

  it('applies live renames in place and refetches when MY role changes', async () => {
    api.get.mockResolvedValueOnce({ data: [ws('a', { organization: { id: 'o1', name: 'Org', isDefault: false } }), ws('b')] });
    const socket = new FakeSocket();
    const { result, unmount } = renderHook(
      () => {
        useWorkspaceLiveUpdates(socket as unknown as Socket, 'me');
        return useWorkspaces();
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));

    act(() => socket.emit('workspace:updated', { id: 'a', name: 'Apollo', description: 'Moon', channelCreationPolicy: 'ADMINS', organizationId: 'o1' }));
    expect(result.current.getWorkspace('a')).toMatchObject({ name: 'Apollo', description: 'Moon', channelCreationPolicy: 'ADMINS' });
    act(() => socket.emit('organization:updated', { id: 'o1', name: 'Renamed Org', slug: 'x', isDefault: false }));
    expect(result.current.getWorkspace('a')?.organization?.name).toBe('Renamed Org');

    // Someone else's role change: nothing to refetch.
    act(() => socket.emit('workspace:member_updated', { workspaceId: 'a', userId: 'you', role: 'ADMIN' }));
    expect(api.get).toHaveBeenCalledTimes(1);
    // Mine: capabilities changed server-side → refetch.
    api.get.mockResolvedValueOnce({ data: [ws('a', { myRole: 'ADMIN', capabilities: { canManage: true } }), ws('b')] });
    act(() => socket.emit('workspace:member_updated', { workspaceId: 'a', userId: 'me', role: 'ADMIN' }));
    await waitFor(() => expect(result.current.getWorkspace('a')?.capabilities?.canManage).toBe(true));
    expect(api.get).toHaveBeenCalledTimes(2);

    act(() => socket.emit('workspace:removed', { workspaceId: 'b', reason: 'removed' }));
    expect(result.current.workspaces.map((w) => w.id)).toEqual(['a']);

    unmount();
    expect(socket.listenerCount('workspace:updated')).toBe(0); // listeners cleaned up
  });

  it('throws a clear error outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useWorkspaces())).toThrow('useWorkspaces must be used within WorkspacesProvider');
  });
});
