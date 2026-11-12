import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceMember } from '../types';
import {
  canChangeOrganizationMemberRole,
  canChangeWorkspaceMemberRole,
  canRemoveOrganizationMember,
  canRemoveWorkspaceMember,
  groupWorkspacesByOrganization,
  organizationWorkspaceActions,
  workspaceAdminAccess,
} from './adminAccess';
import type { OrganizationMember, OrganizationSummary, WorkspaceSettings } from './api';

const settings = (extra: Partial<WorkspaceSettings> = {}, caps: Partial<WorkspaceSettings['capabilities']> = {}): WorkspaceSettings => ({
  id: 'w1',
  name: 'Apollo',
  slug: 'apollo',
  description: null,
  isDefault: false,
  channelCreationPolicy: 'MEMBERS',
  createdAt: '2026-11-01T00:00:00Z',
  owner: { id: 'owner', username: 'olive' },
  organization: { id: 'o1', name: 'Acme', isDefault: false },
  _count: { members: 3 },
  myRole: 'MEMBER',
  organizationRole: 'MEMBER',
  capabilities: { canUpdateSettings: false, canChangeRoles: false, canRemoveMembers: false, canCreateChannel: true, ...caps },
  ...extra,
});
const member = (id: string, role: 'ADMIN' | 'MEMBER', isOwner = false): WorkspaceMember => ({
  id,
  username: id,
  email: `${id}@x.test`,
  title: null,
  role,
  isOwner,
  joinedAt: '2026-11-01T00:00:00Z',
  presence: null,
});
const orgMember = (id: string, role: OrganizationMember['role'], explicit = true): OrganizationMember => ({ id, username: id, email: `${id}@x.test`, role, explicit });
const org = (myRole: OrganizationSummary['myRole'], caps: Partial<OrganizationSummary['capabilities']> = {}, isDefault = false) => ({
  isDefault,
  myRole,
  capabilities: { canUpdate: false, canCreateWorkspace: false, canChangeRoles: false, canRemoveMembers: false, ...caps },
});

describe('workspaceAdminAccess (mirrors lib/policy for visibility only)', () => {
  it('plain member: read-only, may leave, may not delete or manage invitations', () => {
    expect(workspaceAdminAccess(settings())).toEqual({
      isMember: true,
      isOrganizationManager: false,
      canEditSettings: false,
      canChangeRoles: false,
      canRemoveMembers: false,
      canManageInvitations: false,
      canDelete: false,
      canLeave: true,
    });
  });

  it('workspace ADMIN manages but may not delete (owner-level) and may leave', () => {
    const a = workspaceAdminAccess(settings({ myRole: 'ADMIN' }, { canUpdateSettings: true, canRemoveMembers: true }));
    expect(a).toMatchObject({ canEditSettings: true, canManageInvitations: true, canDelete: false, canLeave: true, canChangeRoles: false });
  });

  it('owner deletes but never leaves', () => {
    const a = workspaceAdminAccess(settings({ myRole: 'OWNER', organizationRole: 'OWNER' }, { canUpdateSettings: true, canChangeRoles: true, canRemoveMembers: true }));
    expect(a).toMatchObject({ canDelete: true, canLeave: false });
  });

  it('organization admin who is not a member manages and deletes without membership (no leave)', () => {
    const a = workspaceAdminAccess(settings({ myRole: null, organizationRole: 'ADMIN' }, { canUpdateSettings: true, canChangeRoles: true, canRemoveMembers: true }));
    expect(a).toEqual({
      isMember: false,
      isOrganizationManager: true,
      canEditSettings: true,
      canChangeRoles: true,
      canRemoveMembers: true,
      canManageInvitations: true,
      canDelete: true,
      canLeave: false,
    });
  });

  it('the Default Workspace can never be deleted or left', () => {
    const a = workspaceAdminAccess(settings({ isDefault: true, myRole: 'OWNER', organizationRole: 'OWNER' }, { canUpdateSettings: true }));
    expect(a).toMatchObject({ canDelete: false, canLeave: false, isMember: true });
  });

  it('server-computed list capabilities win over the derived values', () => {
    const entry = { id: 'w1', capabilities: { canManage: true, canManageInvitations: false, canDelete: false } } as Workspace;
    const a = workspaceAdminAccess(settings({ myRole: 'OWNER' }, { canUpdateSettings: true }), entry);
    expect(a.canManageInvitations).toBe(false);
    expect(a.canDelete).toBe(false);
  });
});

describe('member target rules', () => {
  it('workspace roles: never the owner, never yourself', () => {
    const access = workspaceAdminAccess(settings({ myRole: 'OWNER' }, { canChangeRoles: true, canRemoveMembers: true, canUpdateSettings: true }));
    expect(canChangeWorkspaceMemberRole(access, member('owner', 'ADMIN', true), 'me')).toBe(false);
    expect(canChangeWorkspaceMemberRole(access, member('me', 'ADMIN'), 'me')).toBe(false);
    expect(canChangeWorkspaceMemberRole(access, member('bob', 'MEMBER'), 'me')).toBe(true);
    const memberAccess = workspaceAdminAccess(settings());
    expect(canChangeWorkspaceMemberRole(memberAccess, member('bob', 'MEMBER'), 'me')).toBe(false);
  });

  it('workspace removal: admins remove members but not other admins; the owner/org managers remove admins', () => {
    const adminSettings = settings({ myRole: 'ADMIN' }, { canRemoveMembers: true, canUpdateSettings: true });
    const adminAccess = workspaceAdminAccess(adminSettings);
    expect(canRemoveWorkspaceMember(adminAccess, adminSettings, member('bob', 'MEMBER'), 'me')).toBe(true);
    expect(canRemoveWorkspaceMember(adminAccess, adminSettings, member('ada', 'ADMIN'), 'me')).toBe(false);
    expect(canRemoveWorkspaceMember(adminAccess, adminSettings, member('owner', 'ADMIN', true), 'me')).toBe(false);
    const orgSettings = settings({ myRole: null, organizationRole: 'ADMIN' }, { canRemoveMembers: true, canUpdateSettings: true });
    expect(canRemoveWorkspaceMember(workspaceAdminAccess(orgSettings), orgSettings, member('ada', 'ADMIN'), 'me')).toBe(true);
    expect(canRemoveWorkspaceMember(workspaceAdminAccess(orgSettings), orgSettings, member('me', 'MEMBER'), 'me')).toBe(false);
  });

  it('organization roles: OWNER only, never the owner or yourself', () => {
    const owner = org('OWNER', { canChangeRoles: true, canRemoveMembers: true, canUpdate: true });
    expect(canChangeOrganizationMemberRole(owner, orgMember('bob', 'MEMBER', false), 'me')).toBe(true);
    expect(canChangeOrganizationMemberRole(owner, orgMember('me', 'OWNER'), 'me')).toBe(false);
    expect(canChangeOrganizationMemberRole(owner, orgMember('o2', 'OWNER'), 'me')).toBe(false);
    const admin = org('ADMIN', { canRemoveMembers: true, canUpdate: true });
    expect(canChangeOrganizationMemberRole(admin, orgMember('bob', 'MEMBER'), 'me')).toBe(false);
  });

  it('organization removal: admins remove members only; nothing in the Default Organization', () => {
    const admin = org('ADMIN', { canRemoveMembers: true, canUpdate: true });
    expect(canRemoveOrganizationMember(admin, orgMember('bob', 'MEMBER'), 'me')).toBe(true);
    expect(canRemoveOrganizationMember(admin, orgMember('ada', 'ADMIN'), 'me')).toBe(false);
    const owner = org('OWNER', { canRemoveMembers: true, canUpdate: true, canChangeRoles: true });
    expect(canRemoveOrganizationMember(owner, orgMember('ada', 'ADMIN'), 'me')).toBe(true);
    expect(canRemoveOrganizationMember(owner, orgMember('me', 'OWNER'), 'me')).toBe(false);
    expect(canRemoveOrganizationMember(org('OWNER', { canRemoveMembers: true }, true), orgMember('bob', 'MEMBER'), 'me')).toBe(false);
    expect(canRemoveOrganizationMember(org('MEMBER'), orgMember('bob', 'MEMBER'), 'me')).toBe(false);
  });
});

describe('organization workspace actions', () => {
  const ws = (isMember: boolean) => ({ id: 'w', name: 'W', slug: 'w', description: null, isDefault: false, isMember, myRole: isMember ? ('MEMBER' as const) : null });
  it('content (open) only for members; management for members (read) and organization managers', () => {
    expect(organizationWorkspaceActions({ capabilities: org('ADMIN', { canUpdate: true }).capabilities }, ws(false))).toEqual({ canOpen: false, canManage: true });
    expect(organizationWorkspaceActions({ capabilities: org('MEMBER').capabilities }, ws(true))).toEqual({ canOpen: true, canManage: true });
    expect(organizationWorkspaceActions({ capabilities: org('MEMBER').capabilities }, ws(false))).toEqual({ canOpen: false, canManage: false });
  });
});

describe('groupWorkspacesByOrganization', () => {
  it('groups per organization, Default first, server order otherwise', () => {
    const w = (id: string, orgId: string | null, extra: Partial<Workspace> = {}): Workspace => ({
      id,
      name: id,
      slug: id,
      ownerId: 'o',
      organization: orgId ? { id: orgId, name: `Org ${orgId}`, isDefault: orgId === 'def' } : null,
      ...extra,
    });
    const groups = groupWorkspacesByOrganization([w('a', 'o1'), w('d', 'def', { isDefault: true }), w('b', 'o2'), w('c', 'o1')]);
    expect(groups.map((g) => [g.name, g.workspaces.map((x) => x.id)])).toEqual([
      ['Org def', ['d']],
      ['Org o1', ['a', 'c']],
      ['Org o2', ['b']],
    ]);
  });
});
