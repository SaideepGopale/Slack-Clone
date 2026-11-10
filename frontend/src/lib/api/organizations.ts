import { http, seg } from './http';

/**
 * Organization endpoints (Batch 3/B, backend/modules/organizations). Shapes
 * verified against organizations.service.ts. The server decides every
 * permission; `capabilities` only drive what the UI offers.
 */

export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface OrganizationCapabilities {
  canUpdate: boolean;
  canCreateWorkspace: boolean;
  canChangeRoles: boolean;
  canRemoveMembers: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  createdAt?: string;
  myRole: OrganizationRole | null;
  capabilities: OrganizationCapabilities;
}

/** A workspace as listed on its organization's page (managers see all of them, members only theirs). */
export interface OrganizationWorkspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isMember: boolean;
  myRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
}

export interface OrganizationDetails extends OrganizationSummary {
  workspaces: OrganizationWorkspace[];
}

export interface OrganizationMember {
  id: string;
  username: string;
  /** Only for organization owners/admins, and for the member themselves (FA-SEC-03). */
  email?: string;
  role: OrganizationRole;
  /** False when membership is derived from a workspace (implicit MEMBER). */
  explicit: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** GET /api/organizations — organizations the caller belongs to. */
export const listOrganizations = () => http.get<OrganizationSummary[]>('/api/organizations');

/** GET /api/organizations/:id — 404 when the caller isn't a member (existence isn't revealed). */
export const getOrganization = (organizationId: string) => http.get<OrganizationDetails>(`/api/organizations/${seg(organizationId)}`);

/** POST /api/organizations { name } — the creator becomes OWNER. */
export const createOrganization = (name: string) => http.post<OrganizationDetails>('/api/organizations', { name });

/** PATCH /api/organizations/:id { name } — organization OWNER/ADMIN. */
export const renameOrganization = (organizationId: string, name: string) =>
  http.patch<{ id: string; name: string; slug: string; isDefault: boolean }>(`/api/organizations/${seg(organizationId)}`, { name });

export const listOrganizationMembers = async (
  organizationId: string,
  params: { q?: string; cursor?: string | null; limit?: number } = {}
): Promise<Page<OrganizationMember>> => {
  const query: Record<string, string | number> = {};
  if (params.q) query.q = params.q;
  if (params.cursor) query.cursor = params.cursor;
  if (params.limit) query.limit = params.limit;
  const res = await http.get<{ members: OrganizationMember[]; nextCursor: string | null }>(
    `/api/organizations/${seg(organizationId)}/members`,
    Object.keys(query).length ? query : undefined
  );
  return { items: res.members, nextCursor: res.nextCursor };
};

/** PATCH …/members/:userId { role } — organization OWNER only; ownership transfer isn't supported. */
export const changeOrganizationRole = (organizationId: string, userId: string, role: 'ADMIN' | 'MEMBER') =>
  http.patch<{ organizationId: string; userId: string; role: 'ADMIN' | 'MEMBER' }>(
    `/api/organizations/${seg(organizationId)}/members/${seg(userId)}`,
    { role }
  );

/** DELETE …/members/:userId — detaches the person from every workspace of the organization. */
export const removeOrganizationMember = (organizationId: string, userId: string) =>
  http.delete<{ removed: boolean; organizationId: string; userId: string; workspaces: number }>(
    `/api/organizations/${seg(organizationId)}/members/${seg(userId)}`
  );
