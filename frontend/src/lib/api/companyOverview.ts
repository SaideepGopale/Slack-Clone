import { http, seg } from './http';

/** Stage 4 (T.23) — Company Admin workspace overview: read-only metadata (admin-only on the server). */

export type CompanyLevel = 'COMPANY_ADMIN' | 'TEAM_LEAD' | 'MEMBER';
export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED';

export interface CompanySummary {
  totalWorkspaces: number;
  activeWorkspaces: number;
  totalActiveUsers: number;
  totalTeamLeads: number;
  totalTeamMembers: number;
  activeMembers: number;
  suspendedMembers: number;
  suspendedUsers: number;
  invitations: { pending: number; accepted: number; expired: number; revoked: number };
}

export interface OverviewPerson {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  status: AccountStatus;
  level: CompanyLevel;
}

export interface CompanyWorkspace {
  id: string;
  name: string;
  description: string | null;
  type: 'default' | 'team';
  isDefault: boolean;
  owner: OverviewPerson;
  teamLead: { id: string; username: string; displayName: string | null } | null;
  memberCount: number;
  activeMemberCount: number;
  pendingInvitations: number;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface Paged {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface WorkspaceQuery {
  q?: string;
  type?: 'all' | 'default' | 'team';
  status?: 'all' | 'active' | 'inactive';
  teamLeadId?: string;
  minMembers?: number;
  sort?: 'name' | 'createdAt' | 'members';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface CompanyWorkspaceDetail extends Omit<CompanyWorkspace, 'activeMemberCount' | 'pendingInvitations' | 'status'> {
  channelCreationPolicy: 'MEMBERS' | 'ADMINS';
  organization: { id: string; name: string; isDefault: boolean } | null;
  members: (OverviewPerson & { workspaceRole: 'OWNER' | 'ADMIN' | 'MEMBER'; joinedAt: string })[];
  pendingInvitations: { id: string; createdAt: string; expiresAt: string; account: { id: string; username: string; displayName: string | null; email: string } }[];
  activity: { publicChannels: number; privateChannels: number; lastMessageAt: string | null };
}

export interface CompanyTeamLead extends OverviewPerson {
  createdAt: string;
  managedWorkspaces: number;
  teamMembers: number;
  pendingInvitations: number;
}

const BASE = '/api/company-overview';
const clean = (params: object) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== 'all'));

export const getSummary = () => http.get<CompanySummary>(`${BASE}/summary`);
export const listWorkspaces = (query: WorkspaceQuery) => http.get<Paged & { workspaces: CompanyWorkspace[] }>(`${BASE}/workspaces`, clean(query));
export const getWorkspace = (id: string) => http.get<CompanyWorkspaceDetail>(`${BASE}/workspaces/${seg(id)}`);
export const listTeamLeads = (query: { q?: string; page?: number; pageSize?: number }) =>
  http.get<Paged & { teamLeads: CompanyTeamLead[] }>(`${BASE}/team-leads`, clean(query));
