import { http, seg } from './http';

export type ProjectVisibility = 'PUBLIC' | 'PRIVATE';
export type ProjectRole = 'OWNER' | 'MEMBER';

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
