import type { Workspace } from '../types';

/**
 * Pure state transitions for the shared workspace list (F1). Socket payloads
 * (verified against the backend emitters):
 *   workspace:updated            { id, name, description, channelCreationPolicy, organizationId }
 *   workspace:member_updated     { workspaceId, userId, role }
 *   workspace:removed            { workspaceId, reason }            (personal room)
 *   organization:updated         { id, name, slug, isDefault }
 *   organization:member_updated  { organizationId, userId, role }
 *   organization:removed         { organizationId }                 (personal room)
 * Role changes affect server-computed capabilities, so for the current user
 * they trigger a refetch rather than being guessed client-side.
 */

/** Default Workspace first, then the server's order. */
export const sortWorkspaces = (list: Workspace[]) => [...list].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));

export const upsertWorkspace = (list: Workspace[], workspace: Workspace) =>
  list.some((w) => w.id === workspace.id) ? list.map((w) => (w.id === workspace.id ? { ...w, ...workspace } : w)) : [...list, workspace];

export const removeWorkspace = (list: Workspace[], workspaceId: string) => list.filter((w) => w.id !== workspaceId);

export interface WorkspaceUpdatedPayload {
  id: string;
  name?: string;
  description?: string | null;
  channelCreationPolicy?: 'MEMBERS' | 'ADMINS';
  organizationId?: string | null;
}

export const applyWorkspaceUpdated = (list: Workspace[], payload: WorkspaceUpdatedPayload) =>
  list.map((w) =>
    w.id === payload.id
      ? {
          ...w,
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          ...(payload.channelCreationPolicy !== undefined ? { channelCreationPolicy: payload.channelCreationPolicy } : {}),
        }
      : w
  );

export const applyOrganizationUpdated = (list: Workspace[], payload: { id: string; name: string }) =>
  list.map((w) => (w.organization?.id === payload.id ? { ...w, organization: { ...w.organization, name: payload.name } } : w));

/** True when a membership/role event concerns the signed-in user (→ refetch capabilities). */
export const concernsUser = (payload: { userId?: string } | null | undefined, userId: string | undefined) =>
  !!userId && payload?.userId === userId;
