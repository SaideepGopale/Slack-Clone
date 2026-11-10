import type { Workspace, WorkspaceMember } from '../../types';
import { http, seg } from './http';
import type { Page } from './organizations';

/** GET /api/workspaces — the caller's workspaces with roles, organization and capabilities. */
export const listWorkspaces = () => http.get<Workspace[]>('/api/workspaces');

/** POST /api/workspaces — inside an existing organization this needs organization OWNER/ADMIN. */
export const createWorkspace = (input: { name: string; organizationId?: string; description?: string }) =>
  http.post<{ workspace: Workspace; generalChannel: { id: string; name: string } }>('/api/workspaces', input);

export const deleteWorkspace = (workspaceId: string) => http.delete<{ message: string }>(`/api/workspaces/${seg(workspaceId)}`);

export const leaveWorkspace = (workspaceId: string) =>
  http.post<{ left: boolean; workspaceId: string }>(`/api/workspaces/${seg(workspaceId)}/leave`);

export type ChannelCreationPolicy = 'MEMBERS' | 'ADMINS';
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface WorkspaceSettingsCapabilities {
  canUpdateSettings: boolean;
  canChangeRoles: boolean;
  canRemoveMembers: boolean;
  canCreateChannel: boolean;
}

/**
 * GET /api/workspaces/:id/settings (workspace.viewSettings: members and
 * organization OWNER/ADMINs). Shape verified against
 * workspaces.service.ts#getWorkspaceSettings.
 */
export interface WorkspaceSettings {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  channelCreationPolicy: ChannelCreationPolicy;
  createdAt: string;
  owner: { id: string; username: string } | null;
  organization: { id: string; name: string; isDefault: boolean } | null;
  _count: { members: number };
  /** The caller's workspace role; null for an organization manager who isn't a member. */
  myRole: WorkspaceRole | null;
  organizationRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  capabilities: WorkspaceSettingsCapabilities;
}

export const getWorkspaceSettings = (workspaceId: string) => http.get<WorkspaceSettings>(`/api/workspaces/${seg(workspaceId)}/settings`);

export const updateWorkspaceSettings = (
  workspaceId: string,
  patch: Partial<{ name: string; description: string | null; channelCreationPolicy: ChannelCreationPolicy }>
) => http.patch<WorkspaceSettings>(`/api/workspaces/${seg(workspaceId)}`, patch);

/** GET /api/workspaces/:id/members?q=&cursor=&limit= (workspace.viewMembers). */
export const listWorkspaceMembers = async (
  workspaceId: string,
  params: { q?: string; cursor?: string | null; limit?: number } = {}
): Promise<Page<WorkspaceMember>> => {
  const query: Record<string, string | number> = {};
  if (params.q) query.q = params.q;
  if (params.cursor) query.cursor = params.cursor;
  if (params.limit) query.limit = params.limit;
  const res = await http.get<{ members: WorkspaceMember[]; nextCursor: string | null }>(
    `/api/workspaces/${seg(workspaceId)}/members`,
    Object.keys(query).length ? query : undefined
  );
  return { items: res.members, nextCursor: res.nextCursor };
};

/** PATCH …/members/:userId { role } — workspace OWNER or organization OWNER/ADMIN; never the owner or yourself. */
export const changeWorkspaceRole = (workspaceId: string, userId: string, role: 'ADMIN' | 'MEMBER') =>
  http.patch<{ workspaceId: string; userId: string; role: 'ADMIN' | 'MEMBER' }>(
    `/api/workspaces/${seg(workspaceId)}/members/${seg(userId)}`,
    { role }
  );

export const removeWorkspaceMember = (workspaceId: string, userId: string) =>
  http.delete<{ removed: boolean; workspaceId: string; userId: string }>(`/api/workspaces/${seg(workspaceId)}/members/${seg(userId)}`);

// Kept here for existing callers; invitations.ts owns the invitation endpoints.
export { getInviteLink } from './invitations';

// ---- P2: direct membership (workspace managers; enforced by the server) ----
export interface MemberCandidate {
  id: string;
  username: string;
  displayName: string | null;
}

/** Active registered accounts not yet in the workspace (username, display name or exact login). */
export const searchMemberCandidates = (workspaceId: string, q: string) =>
  http.get<{ users: MemberCandidate[] }>(`/api/workspaces/${seg(workspaceId)}/member-candidates`, { q });

/** Adds an existing account directly as a MEMBER (no e-mail, no invitation link). */
export const addWorkspaceMember = (workspaceId: string, userId: string) =>
  http.post<WorkspaceMember>(`/api/workspaces/${seg(workspaceId)}/members`, { userId });
