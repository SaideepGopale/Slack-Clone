import { http, seg } from './http';

/** P2 platform user provisioning (platform admins only; enforced by the server). */

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED';
export type PlatformRole = 'USER' | 'ADMIN';

export interface AdminUser {
  id: string;
  username: string;
  loginId: string;
  displayName: string | null;
  role: PlatformRole;
  status: AccountStatus;
  createdAt: string;
  workspaceCount: number;
}

export interface AdminUserDetails extends AdminUser {
  createdBy: string | null;
  workspaces: { workspaceId: string; name: string; shared: boolean; role: 'OWNER' | 'ADMIN' | 'MEMBER'; joinedAt: string }[];
}

export interface NewUser {
  username: string;
  loginId: string;
  password: string;
  displayName?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
}

export const listUsers = (params: { q?: string; status?: AccountStatus | ''; cursor?: string | null; limit?: number }) =>
  http.get<{ users: AdminUser[]; nextCursor: string | null }>('/api/admin/users', {
    ...(params.q ? { q: params.q } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    limit: params.limit ?? 50,
  });

export const createUser = (body: NewUser) => http.post<AdminUser>('/api/admin/users', body);
export const getUser = (id: string) => http.get<AdminUserDetails>(`/api/admin/users/${seg(id)}`);
export const updateProfile = (id: string, displayName: string) =>
  http.patch<AdminUserDetails>(`/api/admin/users/${seg(id)}/profile`, { displayName });
export const setPassword = (id: string, password: string) => http.post<{ updated: true }>(`/api/admin/users/${seg(id)}/password`, { password });

// Existing moderation endpoints (unchanged server behaviour).
export const toggleRole = (id: string) => http.patch(`/api/admin/users/${seg(id)}/role`);
export const setStatus = (id: string, status: AccountStatus) => http.patch(`/api/admin/users/${seg(id)}/status`, { status });
export const sendResetEmail = (id: string) => http.post(`/api/admin/users/${seg(id)}/force-reset`);
export const deleteUser = (id: string) => http.delete(`/api/admin/users/${seg(id)}`);
