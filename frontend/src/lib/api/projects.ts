import { http, seg } from './http';

export type ProjectVisibility = 'PUBLIC' | 'PRIVATE';
export type ProjectRole = 'OWNER' | 'MEMBER';

// T.33: delivery status ("Archived" is `archived`, not a status).
export const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = { PLANNING: 'Planning', ACTIVE: 'Active', ON_HOLD: 'On hold', COMPLETED: 'Completed' };

export interface ProjectTaskCounts {
  total: number;
  open: number;
  done: number;
  overdue: number;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  visibility: ProjectVisibility;
  archived: boolean;
  archivedAt: string | null;
  memberCount: number;
  channelCount: number;
  myRole?: ProjectRole | null;
  createdAt: string;
  updatedAt: string;
  // T.33 (optional so older payloads still type-check)
  status?: ProjectStatus;
  key?: string;
  requireReview?: boolean;
  startDate?: string | null;
  dueDate?: string | null;
  taskCounts?: ProjectTaskCounts;
}

export interface ProjectDetails extends ProjectSummary {
  owner: { id: string; username: string } | null;
  myRole: ProjectRole | null;
  capabilities: Record<string, boolean>;
}

/** GET /api/workspaces/:id/projects — private projects only for members/managers (F3 screens build on this). */
export const listProjects = (workspaceId: string, params: { status?: 'active' | 'archived' | 'all'; q?: string; cursor?: string } = {}) =>
  http.get<{ projects: ProjectSummary[]; nextCursor: string | null }>(`/api/workspaces/${seg(workspaceId)}/projects`, params);

export const getProject = (projectId: string) => http.get<ProjectDetails>(`/api/projects/${seg(projectId)}`);

export interface ProjectInput {
  name?: string;
  description?: string | null;
  visibility?: ProjectVisibility;
  status?: ProjectStatus;
  key?: string;
  requireReview?: boolean;
  startDate?: string | null;
  dueDate?: string | null;
}

/** POST /api/workspaces/:id/projects — the creator becomes the project OWNER. */
export const createProject = (workspaceId: string, input: ProjectInput & { name: string }) =>
  http.post<ProjectDetails>(`/api/workspaces/${seg(workspaceId)}/projects`, input);

export const updateProject = (projectId: string, input: ProjectInput) => http.patch<ProjectDetails>(`/api/projects/${seg(projectId)}`, input);

export interface ProjectMember {
  userId: string;
  role: ProjectRole;
  joinedAt: string;
  user: { id: string; username: string };
}

export const listProjectMembers = (projectId: string, params: { q?: string; limit?: number; cursor?: string } = { limit: 100 }) =>
  http.get<{ members: ProjectMember[]; nextCursor: string | null }>(`/api/projects/${seg(projectId)}/members`, params);

/** Server capability, accepting both the contract name and the `can…` naming. */
export const projectCan = (project: ProjectDetails | null | undefined, name: string) => {
  if (!project?.capabilities) return false;
  const caps = project.capabilities;
  return !!(caps[name] ?? caps[`can${name[0].toUpperCase()}${name.slice(1)}`]);
};
