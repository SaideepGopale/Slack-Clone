import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { errorMessage, workspacesApi } from '../../lib/api';
import {
  applyOrganizationUpdated,
  applyWorkspaceUpdated,
  concernsUser,
  removeWorkspace,
  sortWorkspaces,
  upsertWorkspace,
  WorkspaceUpdatedPayload,
} from '../../lib/workspaces';
import type { Workspace } from '../../types';

/**
 * The single source of the signed-in user's workspace list (F1). Replaces the
 * four independent GET /api/workspaces calls (WorkspaceRedirect,
 * WorkspaceSwitcher, Sidebar, PeopleDirectory) that could disagree after a
 * rename or role change. Mounted once around every authenticated workspace
 * route (routes/router.tsx), inside the unchanged ProtectedRoute.
 */
export interface WorkspacesContextValue {
  workspaces: Workspace[];
  /** True until the first load settles. */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<Workspace[]>;
  getWorkspace: (workspaceId: string | null | undefined) => Workspace | undefined;
  upsert: (workspace: Workspace) => void;
  remove: (workspaceId: string) => void;
  /** Applies a workspace:updated payload (rename, description, policy). */
  applyUpdated: (payload: WorkspaceUpdatedPayload) => void;
  applyOrganizationUpdated: (payload: { id: string; name: string }) => void;
}

const WorkspacesContext = createContext<WorkspacesContextValue | undefined>(undefined);

export const WorkspacesProvider = ({ children }: { children: ReactNode }) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<Promise<Workspace[]> | null>(null);

  const refresh = useCallback(() => {
    // Concurrent callers (StrictMode double effects, several events at once)
    // share one request instead of racing.
    if (inflight.current) return inflight.current;
    const request = workspacesApi
      .listWorkspaces()
      .then((list) => {
        const sorted = sortWorkspaces(list);
        setWorkspaces(sorted);
        setError(null);
        return sorted;
      })
      .catch((err: unknown) => {
        setError(errorMessage(err, 'Could not load your workspaces.'));
        throw err;
      })
      .finally(() => {
        inflight.current = null;
        setLoading(false);
      });
    inflight.current = request;
    return request;
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const value = useMemo<WorkspacesContextValue>(
    () => ({
      workspaces,
      loading,
      error,
      refresh,
      getWorkspace: (id) => (id ? workspaces.find((w) => w.id === id) : undefined),
      upsert: (workspace) => setWorkspaces((list) => sortWorkspaces(upsertWorkspace(list, workspace))),
      remove: (id) => setWorkspaces((list) => removeWorkspace(list, id)),
      applyUpdated: (payload) => setWorkspaces((list) => applyWorkspaceUpdated(list, payload)),
      applyOrganizationUpdated: (payload) => setWorkspaces((list) => applyOrganizationUpdated(list, payload)),
    }),
    [workspaces, loading, error, refresh]
  );

  return <WorkspacesContext.Provider value={value}>{children}</WorkspacesContext.Provider>;
};

export const useWorkspaces = () => {
  const ctx = useContext(WorkspacesContext);
  if (!ctx) throw new Error('useWorkspaces must be used within WorkspacesProvider');
  return ctx;
};

/**
 * Keeps the shared list live. Call it where the socket lives (WorkspaceLayout).
 * Renames are applied in place; anything that changes the signed-in user's
 * roles (and therefore server-computed capabilities) triggers a refetch.
 */
export const useWorkspaceLiveUpdates = (socket: Socket | null, userId: string | undefined) => {
  const { refresh, remove, applyUpdated, applyOrganizationUpdated: applyOrgUpdated } = useWorkspaces();

  useEffect(() => {
    if (!socket) return;
    const reload = () => {
      refresh().catch(() => undefined);
    };
    const onWorkspaceUpdated = (payload: WorkspaceUpdatedPayload) => applyUpdated(payload);
    const onMemberUpdated = (payload: { userId?: string }) => {
      if (concernsUser(payload, userId)) reload();
    };
    const onWorkspaceRemoved = ({ workspaceId }: { workspaceId: string }) => remove(workspaceId);
    const onOrganizationUpdated = (payload: { id: string; name: string }) => applyOrgUpdated(payload);

    socket.on('workspace:updated', onWorkspaceUpdated);
    socket.on('workspace:member_updated', onMemberUpdated);
    socket.on('workspace:removed', onWorkspaceRemoved);
    socket.on('organization:updated', onOrganizationUpdated);
    socket.on('organization:member_updated', onMemberUpdated);
    socket.on('organization:removed', reload);
    return () => {
      socket.off('workspace:updated', onWorkspaceUpdated);
      socket.off('workspace:member_updated', onMemberUpdated);
      socket.off('workspace:removed', onWorkspaceRemoved);
      socket.off('organization:updated', onOrganizationUpdated);
      socket.off('organization:member_updated', onMemberUpdated);
      socket.off('organization:removed', reload);
    };
  }, [socket, userId, refresh, remove, applyUpdated, applyOrgUpdated]);
};
