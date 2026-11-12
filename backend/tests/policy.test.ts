import { describe, expect, it } from 'vitest';
import { HttpError } from '../lib/httpError';
import {
  assertOrganization,
  assertProject,
  assertWorkspace,
  canChangeOrganizationRole,
  canChangeWorkspaceRole,
  canLeaveProject,
  canManageChannelPlacement,
  canOrganization,
  canProject,
  canRemoveOrganizationMember,
  canRemoveProjectMember,
  canRemoveWorkspaceMember,
  canTransferProjectOwnership,
  canWorkspace,
  OrganizationActor,
  OrganizationRoleName,
  ProjectAction,
  ProjectActor,
  ProjectRoleName,
  projectAllowsChannelAccess,
  WorkspaceActor,
  WorkspaceRoleName,
  assertChannel,
  canAddChannelMember,
  canChangeChannelRole,
  canChannel,
  canChannelContent,
  canLeaveChannel,
  canRemoveChannelMember,
  ChannelAction,
  ChannelActor,
  ChannelRoleName,
  normalizeChannelRole,
  canJoinWorkspaces,
  canRemoveGroupDMParticipant,
  INVITATION_TTL_MS,
  invitationAcceptanceDenial,
  invitationState,
  normalizeEmail,
} from '../lib/policy';

/**
 * Exhaustive permission matrix for the Sub-batch B policy (organizations and
 * workspaces). Expected values are written out literally per role
 * combination — not recomputed from the same rules — so a policy change has
 * to be made deliberately in both places.
 */

const org = (role: OrganizationRoleName | null, implicit = false, isDefault = false): OrganizationActor => ({
  userId: 'actor',
  organizationId: 'org',
  isDefaultOrganization: isDefault,
  role,
  implicit,
});

const ws = (
  workspaceRole: WorkspaceRoleName | null,
  organizationRole: OrganizationRoleName | null,
  channelCreationPolicy: 'MEMBERS' | 'ADMINS' = 'MEMBERS'
): WorkspaceActor => ({
  userId: 'actor',
  workspaceId: 'ws',
  organizationId: 'org',
  isDefaultWorkspace: false,
  channelCreationPolicy,
  workspaceRole,
  organizationRole,
});

describe('organization permission matrix', () => {
  // [label, actor, view, viewMembers, update, createWorkspace, changeMemberRole, removeMember]
  const rows: [string, OrganizationActor, ...boolean[]][] = [
    ['OWNER', org('OWNER'), true, true, true, true, true, true],
    ['ADMIN', org('ADMIN'), true, true, true, true, false, true],
    ['MEMBER (explicit)', org('MEMBER'), true, true, false, false, false, false],
    ['MEMBER (implicit)', org('MEMBER', true), true, true, false, false, false, false],
    ['not a member', org(null), false, false, false, false, false, false],
  ];
  const actions = [
    'organization.view',
    'organization.viewMembers',
    'organization.update',
    'organization.createWorkspace',
    'organization.changeMemberRole',
    'organization.removeMember',
  ] as const;

  for (const [label, actor, ...expected] of rows) {
    it(`${label}`, () => {
      actions.forEach((action, i) => expect(canOrganization(actor, action), `${label} → ${action}`).toBe(expected[i]));
    });
  }
});

describe('workspace permission matrix (incl. inheritance from organization roles)', () => {
  // [wsRole, orgRole, view, viewSettings, updateSettings, removeMember, changeMemberRole, createChannel@MEMBERS, createChannel@ADMINS]
  const rows: [WorkspaceRoleName | null, OrganizationRoleName | null, ...boolean[]][] = [
    ['OWNER', 'OWNER', true, true, true, true, true, true, true],
    ['OWNER', 'ADMIN', true, true, true, true, true, true, true],
    ['OWNER', 'MEMBER', true, true, true, true, true, true, true],
    ['OWNER', null, true, true, true, true, true, true, true],
    ['ADMIN', 'OWNER', true, true, true, true, true, true, true],
    ['ADMIN', 'ADMIN', true, true, true, true, true, true, true],
    ['ADMIN', 'MEMBER', true, true, true, true, false, true, true],
    ['ADMIN', null, true, true, true, true, false, true, true],
    ['MEMBER', 'OWNER', true, true, true, true, true, true, true],
    ['MEMBER', 'ADMIN', true, true, true, true, true, true, true],
    ['MEMBER', 'MEMBER', true, true, false, false, false, true, false],
    ['MEMBER', null, true, true, false, false, false, true, false],
    // Organization managers who are NOT workspace members: management yes,
    // content-level actions (view, create channels) no.
    [null, 'OWNER', false, true, true, true, true, false, false],
    [null, 'ADMIN', false, true, true, true, true, false, false],
    [null, 'MEMBER', false, false, false, false, false, false, false],
    [null, null, false, false, false, false, false, false, false],
  ];

  for (const [wsRole, orgRole, view, viewSettings, update, remove, changeRole, createMembers, createAdmins] of rows) {
    it(`workspace ${wsRole ?? 'none'} / organization ${orgRole ?? 'none'}`, () => {
      const actor = ws(wsRole, orgRole);
      expect(canWorkspace(actor, 'workspace.view')).toBe(view);
      expect(canWorkspace(actor, 'workspace.viewSettings')).toBe(viewSettings);
      expect(canWorkspace(actor, 'workspace.updateSettings')).toBe(update);
      expect(canWorkspace(actor, 'workspace.removeMember')).toBe(remove);
      expect(canWorkspace(actor, 'workspace.changeMemberRole')).toBe(changeRole);
      expect(canWorkspace(actor, 'workspace.createChannel')).toBe(createMembers);
      expect(canWorkspace(ws(wsRole, orgRole, 'ADMINS'), 'workspace.createChannel')).toBe(createAdmins);
    });
  }
});

describe('target-specific rules', () => {
  const member = { userId: 'target', role: 'MEMBER' as const };
  const admin = { userId: 'target', role: 'ADMIN' as const };
  const owner = { userId: 'target', role: 'OWNER' as const };
  const self = { userId: 'actor', role: 'MEMBER' as const };

  it('workspace removal: admins remove members; only owner-level removes admins; owner and self never', () => {
    expect(canRemoveWorkspaceMember(ws('ADMIN', null), member)).toBe(true);
    expect(canRemoveWorkspaceMember(ws('ADMIN', null), admin)).toBe(false);
    expect(canRemoveWorkspaceMember(ws('OWNER', null), admin)).toBe(true);
    expect(canRemoveWorkspaceMember(ws(null, 'ADMIN'), admin)).toBe(true);
    expect(canRemoveWorkspaceMember(ws('OWNER', 'OWNER'), owner)).toBe(false);
    expect(canRemoveWorkspaceMember(ws('ADMIN', 'OWNER'), self)).toBe(false);
    expect(canRemoveWorkspaceMember(ws('MEMBER', null), member)).toBe(false);
  });

  it('workspace role change: owner-level only; never the owner, never yourself', () => {
    expect(canChangeWorkspaceRole(ws('OWNER', null), member)).toBe(true);
    expect(canChangeWorkspaceRole(ws('OWNER', null), admin)).toBe(true);
    expect(canChangeWorkspaceRole(ws(null, 'ADMIN'), member)).toBe(true);
    expect(canChangeWorkspaceRole(ws('ADMIN', null), member)).toBe(false);
    expect(canChangeWorkspaceRole(ws('OWNER', 'OWNER'), owner)).toBe(false);
    expect(canChangeWorkspaceRole(ws('OWNER', null), self)).toBe(false);
  });

  it('organization role change: OWNER only (explicit); never the owner, never yourself', () => {
    expect(canChangeOrganizationRole(org('OWNER'), member)).toBe(true);
    expect(canChangeOrganizationRole(org('OWNER'), admin)).toBe(true);
    expect(canChangeOrganizationRole(org('OWNER'), owner)).toBe(false);
    expect(canChangeOrganizationRole(org('OWNER'), self)).toBe(false);
    expect(canChangeOrganizationRole(org('ADMIN'), member)).toBe(false);
  });

  it('organization removal: managers remove members, only OWNER removes admins; default org never', () => {
    expect(canRemoveOrganizationMember(org('ADMIN'), member)).toBe(true);
    expect(canRemoveOrganizationMember(org('ADMIN'), admin)).toBe(false);
    expect(canRemoveOrganizationMember(org('OWNER'), admin)).toBe(true);
    expect(canRemoveOrganizationMember(org('OWNER'), owner)).toBe(false);
    expect(canRemoveOrganizationMember(org('OWNER'), self)).toBe(false);
    expect(canRemoveOrganizationMember(org('MEMBER'), member)).toBe(false);
    expect(canRemoveOrganizationMember(org('OWNER', false, true), member)).toBe(false);
  });

  it('assertions raise HttpErrors (404 for non-members of an organization, 403 otherwise)', () => {
    expect(() => assertOrganization(org(null), 'organization.view')).toThrow(HttpError);
    try {
      assertOrganization(org(null), 'organization.view');
    } catch (err) {
      expect((err as HttpError).status).toBe(404);
    }
    try {
      assertOrganization(org('MEMBER'), 'organization.update');
    } catch (err) {
      expect((err as HttpError).status).toBe(403);
    }
    expect(() => assertWorkspace(ws('MEMBER', null), 'workspace.updateSettings')).toThrow(/owners and admins/);
    expect(() => assertWorkspace(ws('ADMIN', null), 'workspace.updateSettings')).not.toThrow();
  });
});

// ---- Sub-batch C: projects ---------------------------------------------------

const project = (
  workspaceRole: WorkspaceRoleName | null,
  organizationRole: OrganizationRoleName | null,
  projectRole: ProjectRoleName | null,
  visibility: 'PUBLIC' | 'PRIVATE',
  archived = false
): ProjectActor => ({
  userId: 'actor',
  projectId: 'project',
  workspace: ws(workspaceRole, organizationRole),
  visibility,
  archived,
  projectRole,
});

describe('workspace project actions', () => {
  // [wsRole, orgRole, viewProjects, createProject]
  const rows: [WorkspaceRoleName | null, OrganizationRoleName | null, boolean, boolean][] = [
    ['OWNER', null, true, true],
    ['ADMIN', null, true, true],
    ['MEMBER', null, true, true],
    [null, 'OWNER', true, false],
    [null, 'ADMIN', true, false],
    [null, 'MEMBER', false, false],
    [null, null, false, false],
  ];
  for (const [wsRole, orgRole, viewProjects, createProject] of rows) {
    it(`workspace ${wsRole ?? 'none'} / organization ${orgRole ?? 'none'}`, () => {
      expect(canWorkspace(ws(wsRole, orgRole), 'workspace.viewProjects')).toBe(viewProjects);
      expect(canWorkspace(ws(wsRole, orgRole), 'workspace.createProject')).toBe(createProject);
    });
  }
});

describe('project permission matrix', () => {
  const actions: ProjectAction[] = [
    'project.view',
    'project.update',
    'project.archive',
    'project.join',
    'project.manageMembers',
    'project.transferOwnership',
    'project.manageChannels',
    'project.createChannel',
  ];
  // [label, actor, view, update, archive, join, manageMembers, transferOwnership, manageChannels, createChannel]
  const T = true;
  const F = false;
  const rows: [string, ProjectActor, ...boolean[]][] = [
    ['project OWNER, public', project('MEMBER', null, 'OWNER', 'PUBLIC'), T, T, T, T, T, T, T, T],
    ['project OWNER, private', project('MEMBER', null, 'OWNER', 'PRIVATE'), T, T, T, F, T, T, T, T],
    ['project MEMBER, public', project('MEMBER', null, 'MEMBER', 'PUBLIC'), T, F, F, T, F, F, F, T],
    ['project MEMBER, private', project('MEMBER', null, 'MEMBER', 'PRIVATE'), T, F, F, F, F, F, F, T],
    ['workspace MEMBER (not in project), public', project('MEMBER', null, null, 'PUBLIC'), T, F, F, T, F, F, F, F],
    ['workspace MEMBER (not in project), private', project('MEMBER', null, null, 'PRIVATE'), F, F, F, F, F, F, F, F],
    ['workspace ADMIN (not in project), private', project('ADMIN', null, null, 'PRIVATE'), T, T, T, F, T, T, T, F],
    ['workspace OWNER (not in project), public', project('OWNER', null, null, 'PUBLIC'), T, T, T, T, T, T, T, F],
    ['organization ADMIN (no workspace membership), private', project(null, 'ADMIN', null, 'PRIVATE'), T, T, T, F, T, T, T, F],
    ['organization OWNER (no workspace membership), public', project(null, 'OWNER', null, 'PUBLIC'), T, T, T, F, T, T, T, F],
    ['organization MEMBER only, public', project(null, 'MEMBER', null, 'PUBLIC'), F, F, F, F, F, F, F, F],
    ['outsider, public', project(null, null, null, 'PUBLIC'), F, F, F, F, F, F, F, F],
    // A ProjectMember row that outlived the workspace membership grants nothing.
    ['stale project OWNER row, private', project(null, null, 'OWNER', 'PRIVATE'), F, F, F, F, F, F, F, F],
    ['stale project MEMBER row, public', project(null, null, 'MEMBER', 'PUBLIC'), F, F, F, F, F, F, F, F],
    // Archived: read-only except archive/restore.
    ['project OWNER, private, archived', project('MEMBER', null, 'OWNER', 'PRIVATE', true), T, F, T, F, F, F, F, F],
    ['project MEMBER, public, archived', project('MEMBER', null, 'MEMBER', 'PUBLIC', true), T, F, F, F, F, F, F, F],
    ['workspace ADMIN, private, archived', project('ADMIN', null, null, 'PRIVATE', true), T, F, T, F, F, F, F, F],
    ['workspace MEMBER, public, archived', project('MEMBER', null, null, 'PUBLIC', true), T, F, F, F, F, F, F, F],
  ];

  for (const [label, actor, ...expected] of rows) {
    it(label, () => {
      actions.forEach((action, i) => expect(canProject(actor, action), `${label} → ${action}`).toBe(expected[i]));
    });
  }
});

describe('project target rules and assertions', () => {
  const member = { userId: 'target', role: 'MEMBER' as const };
  const owner = { userId: 'target', role: 'OWNER' as const };
  const self = { userId: 'actor', role: 'MEMBER' as const };

  it('removal: owner/managers remove members; never the owner, never yourself, never while archived', () => {
    expect(canRemoveProjectMember(project('MEMBER', null, 'OWNER', 'PRIVATE'), member)).toBe(true);
    expect(canRemoveProjectMember(project('ADMIN', null, null, 'PRIVATE'), member)).toBe(true);
    expect(canRemoveProjectMember(project(null, 'ADMIN', null, 'PUBLIC'), member)).toBe(true);
    expect(canRemoveProjectMember(project('ADMIN', null, null, 'PRIVATE'), owner)).toBe(false);
    expect(canRemoveProjectMember(project('MEMBER', null, 'OWNER', 'PRIVATE'), self)).toBe(false);
    expect(canRemoveProjectMember(project('MEMBER', null, 'MEMBER', 'PUBLIC'), member)).toBe(false);
    expect(canRemoveProjectMember(project('MEMBER', null, 'OWNER', 'PUBLIC', true), member)).toBe(false);
  });

  it('ownership transfer: only to an existing MEMBER, by the owner or managers, never while archived', () => {
    expect(canTransferProjectOwnership(project('MEMBER', null, 'OWNER', 'PUBLIC'), member)).toBe(true);
    expect(canTransferProjectOwnership(project('ADMIN', null, null, 'PRIVATE'), member)).toBe(true);
    expect(canTransferProjectOwnership(project(null, 'OWNER', null, 'PRIVATE'), member)).toBe(true);
    expect(canTransferProjectOwnership(project('MEMBER', null, 'MEMBER', 'PUBLIC'), member)).toBe(false);
    expect(canTransferProjectOwnership(project('MEMBER', null, 'OWNER', 'PUBLIC'), owner)).toBe(false);
    expect(canTransferProjectOwnership(project('MEMBER', null, 'OWNER', 'PUBLIC', true), member)).toBe(false);
  });

  it('leaving: members only (the owner transfers first); not while archived; not via a stale row', () => {
    expect(canLeaveProject(project('MEMBER', null, 'MEMBER', 'PRIVATE'))).toBe(true);
    expect(canLeaveProject(project('MEMBER', null, 'OWNER', 'PRIVATE'))).toBe(false);
    expect(canLeaveProject(project('MEMBER', null, null, 'PUBLIC'))).toBe(false);
    expect(canLeaveProject(project('MEMBER', null, 'MEMBER', 'PUBLIC', true))).toBe(false);
    expect(canLeaveProject(project(null, null, 'MEMBER', 'PUBLIC'))).toBe(false);
  });

  it('channel placement needs channel ownership (legacy "admin") or workspace management power', () => {
    expect(canManageChannelPlacement(ws('MEMBER', null), 'admin')).toBe(true);
    expect(canManageChannelPlacement(ws('MEMBER', null), 'member')).toBe(false);
    expect(canManageChannelPlacement(ws('MEMBER', null), null)).toBe(false);
    expect(canManageChannelPlacement(ws('ADMIN', null), null)).toBe(true);
    expect(canManageChannelPlacement(ws(null, 'ADMIN'), null)).toBe(true);
    expect(canManageChannelPlacement(ws(null, null), 'admin')).toBe(false); // stale channel row
  });

  it('channels of a private project admit project members only', () => {
    expect(projectAllowsChannelAccess(null, false)).toBe(true);
    expect(projectAllowsChannelAccess({ visibility: 'PUBLIC' }, false)).toBe(true);
    expect(projectAllowsChannelAccess({ visibility: 'PRIVATE' }, true)).toBe(true);
    expect(projectAllowsChannelAccess({ visibility: 'PRIVATE' }, false)).toBe(false);
  });

  it('assertProject: 404 when invisible, 409 when only the archive blocks it, 403 otherwise', () => {
    const status = (fn: () => void) => {
      try {
        fn();
        return 200;
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        return (err as HttpError).status;
      }
    };
    expect(status(() => assertProject(project('MEMBER', null, null, 'PRIVATE'), 'project.view'))).toBe(404);
    expect(status(() => assertProject(project('MEMBER', null, null, 'PRIVATE'), 'project.update'))).toBe(404);
    expect(status(() => assertProject(project('MEMBER', null, 'OWNER', 'PUBLIC', true), 'project.update'))).toBe(409);
    expect(status(() => assertProject(project('MEMBER', null, 'MEMBER', 'PUBLIC', true), 'project.update'))).toBe(403);
    expect(status(() => assertProject(project('MEMBER', null, 'MEMBER', 'PUBLIC'), 'project.manageMembers'))).toBe(403);
    expect(status(() => assertProject(project('MEMBER', null, 'OWNER', 'PUBLIC'), 'project.update'))).toBe(200);
  });
});

// ---- Sub-batch D: channels ---------------------------------------------------

interface ChanOpts {
  ws?: WorkspaceRoleName | null;
  org?: OrganizationRoleName | null;
  role?: ChannelRoleName | null;
  visibility?: 'PUBLIC' | 'PRIVATE';
  announcement?: boolean;
  archived?: boolean;
  kind?: 'channel' | 'dm' | 'groupDm';
  general?: boolean;
  projectAdmits?: boolean;
}
const chan = (o: ChanOpts = {}): ChannelActor => ({
  userId: 'actor',
  channelId: 'channel',
  workspace: ws(o.ws === undefined ? 'MEMBER' : o.ws, o.org ?? null),
  kind: o.kind ?? 'channel',
  isGeneral: o.general ?? false,
  visibility: o.visibility ?? 'PUBLIC',
  isAnnouncement: o.announcement ?? false,
  archived: o.archived ?? false,
  projectAdmits: o.projectAdmits ?? true,
  channelRole: o.role === undefined ? null : o.role,
});

describe('channel permission matrix', () => {
  const actions: ChannelAction[] = [
    'channel.view',
    'channel.read',
    'channel.join',
    'channel.leave',
    'channel.updateInfo',
    'channel.updateSettings',
    'channel.archive',
    'channel.addMembers',
    'channel.removeMembers',
    'channel.changeRoles',
    'channel.post',
    'channel.reply',
    'channel.react',
  ];
  const T = true;
  const F = false;
  // [label, actor, view, read, join, leave, updateInfo, updateSettings, archive, addMembers, removeMembers, changeRoles, post, reply, react]
  const rows: [string, ChannelActor, ...boolean[]][] = [
    ['owner, public', chan({ role: 'admin' }), T, T, T, T, T, T, T, T, T, T, T, T, T],
    ['moderator, public', chan({ role: 'moderator' }), T, T, T, T, T, F, F, T, T, F, T, T, T],
    ['member, public', chan({ role: 'member' }), T, T, T, T, F, F, F, T, F, F, T, T, T],
    ['workspace member (not in channel), public', chan(), T, F, T, F, F, F, F, F, F, F, F, F, F],
    ['workspace member (not in channel), private', chan({ visibility: 'PRIVATE' }), F, F, F, F, F, F, F, F, F, F, F, F, F],
    ['member, private', chan({ role: 'member', visibility: 'PRIVATE' }), T, T, F, T, F, F, F, F, F, F, T, T, T],
    ['moderator, private', chan({ role: 'moderator', visibility: 'PRIVATE' }), T, T, F, T, T, F, F, T, T, F, T, T, T],
    ['workspace ADMIN (not in channel), private', chan({ ws: 'ADMIN', visibility: 'PRIVATE' }), T, F, F, F, T, T, T, T, T, T, F, F, F],
    ['organization ADMIN (no workspace membership), public', chan({ ws: null, org: 'ADMIN' }), T, F, F, F, T, T, T, T, T, T, F, F, F],
    ['member, announcement', chan({ role: 'member', announcement: true }), T, T, T, T, F, F, F, T, F, F, F, T, T],
    ['moderator, announcement', chan({ role: 'moderator', announcement: true }), T, T, T, T, T, F, F, T, T, F, T, T, T],
    ['workspace ADMIN who is a member, announcement', chan({ ws: 'ADMIN', role: 'member', announcement: true }), T, T, T, T, T, T, T, T, T, T, T, T, T],
    ['owner, archived', chan({ role: 'admin', archived: true }), T, T, F, T, F, F, T, F, T, F, F, F, F],
    ['member, archived', chan({ role: 'member', archived: true }), T, T, F, T, F, F, F, F, F, F, F, F, F],
    // Private project that doesn't admit the user: a channel row grants nothing.
    ['member row, private project not admitting', chan({ role: 'member', projectAdmits: false }), F, F, F, F, F, F, F, F, F, F, F, F, F],
    ['stale owner row, not in workspace', chan({ ws: null, role: 'admin' }), F, F, F, F, F, F, F, F, F, F, F, F, F],
    ['owner of General', chan({ role: 'admin', general: true }), T, T, T, F, T, T, F, T, F, T, T, T, T],
    ['DM participant', chan({ role: 'member', kind: 'dm' }), T, T, F, F, F, F, F, F, F, F, T, T, T],
    ['workspace ADMIN, not in the DM', chan({ ws: 'ADMIN', kind: 'dm' }), F, F, F, F, F, F, F, F, F, F, F, F, F],
  ];
  for (const [label, actor, ...expected] of rows) {
    it(label, () => {
      actions.forEach((action, i) => expect(canChannel(actor, action), `${label} → ${action}`).toBe(expected[i]));
    });
  }
});

describe('channel target rules, content rules and assertions', () => {
  const t = (role: ChannelRoleName, userId = 'target') => ({ userId, role });

  it('legacy roles keep their meaning', () => {
    expect(normalizeChannelRole('admin')).toBe('admin');
    expect(normalizeChannelRole('moderator')).toBe('moderator');
    expect(normalizeChannelRole('member')).toBe('member');
    expect(normalizeChannelRole('something-else')).toBe('member');
    expect(normalizeChannelRole(null)).toBeNull();
  });

  it('removal: owner/managers remove anyone but the owner; moderators remove members only; never yourself', () => {
    expect(canRemoveChannelMember(chan({ role: 'admin' }), t('moderator'))).toBe(true);
    expect(canRemoveChannelMember(chan({ role: 'admin' }), t('member'))).toBe(true);
    expect(canRemoveChannelMember(chan({ role: 'moderator' }), t('member'))).toBe(true);
    expect(canRemoveChannelMember(chan({ role: 'moderator' }), t('moderator'))).toBe(false);
    expect(canRemoveChannelMember(chan({ ws: 'ADMIN', visibility: 'PRIVATE' }), t('moderator'))).toBe(true);
    expect(canRemoveChannelMember(chan({ ws: 'ADMIN' }), t('admin'))).toBe(false);
    expect(canRemoveChannelMember(chan({ role: 'admin' }), t('member', 'actor'))).toBe(false);
    expect(canRemoveChannelMember(chan({ role: 'member' }), t('member'))).toBe(false);
    expect(canRemoveChannelMember(chan({ role: 'admin', archived: true }), t('member'))).toBe(true);
    expect(canRemoveChannelMember(chan({ role: 'admin', general: true }), t('member'))).toBe(false);
  });

  it('roles: owner/managers only; never your own role; the owner only changes by transfer', () => {
    expect(canChangeChannelRole(chan({ role: 'admin' }), t('member'), 'moderator')).toBe(true);
    expect(canChangeChannelRole(chan({ role: 'admin' }), t('moderator'), 'member')).toBe(true);
    expect(canChangeChannelRole(chan({ role: 'admin' }), t('member'), 'admin')).toBe(true);
    expect(canChangeChannelRole(chan({ ws: 'ADMIN' }), t('member'), 'admin')).toBe(true);
    expect(canChangeChannelRole(chan({ role: 'moderator' }), t('member'), 'moderator')).toBe(false);
    expect(canChangeChannelRole(chan({ role: 'moderator' }), t('moderator', 'actor'), 'admin')).toBe(false);
    expect(canChangeChannelRole(chan({ role: 'member' }), t('member', 'actor'), 'moderator')).toBe(false);
    expect(canChangeChannelRole(chan({ role: 'admin' }), t('admin', 'actor'), 'member')).toBe(false);
    expect(canChangeChannelRole(chan({ ws: 'ADMIN' }), t('admin'), 'member')).toBe(false);
    expect(canChangeChannelRole(chan({ role: 'admin', archived: true }), t('member'), 'moderator')).toBe(false);
    expect(canChangeChannelRole(chan({ role: 'admin' }), t('member'), 'superuser' as ChannelRoleName)).toBe(false);
  });

  it('adding: managers never add themselves to a private channel; leaving: the owner transfers first', () => {
    expect(canAddChannelMember(chan({ ws: 'ADMIN', visibility: 'PRIVATE' }), 'actor')).toBe(false);
    expect(canAddChannelMember(chan({ ws: 'ADMIN', visibility: 'PRIVATE' }), 'someone')).toBe(true);
    expect(canAddChannelMember(chan({ role: 'member', visibility: 'PRIVATE' }), 'someone')).toBe(false);
    expect(canAddChannelMember(chan({ role: 'member' }), 'someone')).toBe(true);
    expect(canLeaveChannel(chan({ role: 'admin' }), 2)).toBe(false);
    expect(canLeaveChannel(chan({ role: 'admin' }), 0)).toBe(true);
    expect(canLeaveChannel(chan({ role: 'member' }), 5)).toBe(true);
    expect(canLeaveChannel(chan({ role: 'member', general: true }), 5)).toBe(false);
  });

  it('content: archived is read-only for everyone; announcement limits top-level posts only', () => {
    const ctx = (role: ChannelRoleName | null, extra: { archived?: boolean; isAnnouncement?: boolean; isManager?: boolean } = {}) => ({
      role,
      archived: false,
      isAnnouncement: false,
      isManager: false,
      ...extra,
    });
    for (const action of ['post', 'reply', 'react', 'edit', 'delete', 'pin', 'vote'] as const) {
      expect(canChannelContent(ctx('admin', { archived: true }), action)).toBe(false);
      expect(canChannelContent(ctx(null), action)).toBe(false);
      expect(canChannelContent(ctx('member'), action)).toBe(true);
    }
    expect(canChannelContent(ctx('member', { isAnnouncement: true }), 'post')).toBe(false);
    expect(canChannelContent(ctx('member', { isAnnouncement: true }), 'reply')).toBe(true);
    expect(canChannelContent(ctx('member', { isAnnouncement: true }), 'react')).toBe(true);
    expect(canChannelContent(ctx('moderator', { isAnnouncement: true }), 'post')).toBe(true);
    expect(canChannelContent(ctx('member', { isAnnouncement: true, isManager: true }), 'post')).toBe(true);
    expect(canChannelContent(ctx(null, { isAnnouncement: true, isManager: true }), 'post')).toBe(false);
  });

  it('assertChannel: 404 when invisible, 409 when only the archive blocks it, 403 otherwise', () => {
    const status = (fn: () => void) => {
      try {
        fn();
        return 200;
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        return (err as HttpError).status;
      }
    };
    expect(status(() => assertChannel(chan({ visibility: 'PRIVATE' }), 'channel.join'))).toBe(404);
    expect(status(() => assertChannel(chan({ visibility: 'PRIVATE' }), 'channel.updateSettings'))).toBe(404);
    expect(status(() => assertChannel(chan({ role: 'admin', archived: true }), 'channel.updateSettings'))).toBe(409);
    expect(status(() => assertChannel(chan({ role: 'member', archived: true }), 'channel.updateSettings'))).toBe(403);
    expect(status(() => assertChannel(chan({ role: 'member' }), 'channel.changeRoles'))).toBe(403);
    expect(status(() => assertChannel(chan({ role: 'admin' }), 'channel.changeRoles'))).toBe(200);
  });
});

// ---- Sub-batch E: consolidated legacy checks --------------------------------

describe('workspace access-management actions (Sub-batch E)', () => {
  // [wsRole, orgRole, viewMembers, manageInvitations, delete]
  const rows: [WorkspaceRoleName | null, OrganizationRoleName | null, boolean, boolean, boolean][] = [
    ['OWNER', 'OWNER', true, true, true],
    ['OWNER', null, true, true, true],
    ['ADMIN', 'OWNER', true, true, true],
    ['ADMIN', 'ADMIN', true, true, true],
    ['ADMIN', 'MEMBER', true, true, false], // workspace admins can't delete the tenant
    ['ADMIN', null, true, true, false],
    ['MEMBER', 'OWNER', true, true, true],
    ['MEMBER', 'ADMIN', true, true, true],
    ['MEMBER', 'MEMBER', true, false, false],
    ['MEMBER', null, true, false, false],
    [null, 'OWNER', true, true, true], // organization managers manage without membership
    [null, 'ADMIN', true, true, true],
    [null, 'MEMBER', false, false, false],
    [null, null, false, false, false],
  ];
  for (const [wsRole, orgRole, viewMembers, manageInvitations, del] of rows) {
    it(`workspace ${wsRole ?? 'none'} / organization ${orgRole ?? 'none'}`, () => {
      const actor = ws(wsRole, orgRole);
      expect(canWorkspace(actor, 'workspace.viewMembers')).toBe(viewMembers);
      expect(canWorkspace(actor, 'workspace.manageInvitations')).toBe(manageInvitations);
      expect(canWorkspace(actor, 'workspace.delete')).toBe(del);
    });
  }

  it('the Default Workspace can never be deleted, not even by its owner', () => {
    const actor = { ...ws('OWNER', 'OWNER'), isDefaultWorkspace: true };
    expect(canWorkspace(actor, 'workspace.delete')).toBe(false);
    // P2: the shared workspace (SmartConnect Collab) is platform-managed —
    // everyone already has access, so its settings, roles and invitations are
    // locked for everyone, while ordinary collaboration stays open.
    for (const locked of ['workspace.manageInvitations', 'workspace.updateSettings', 'workspace.changeMemberRole'] as const) {
      expect(canWorkspace(actor, locked), locked).toBe(false);
    }
    expect(canWorkspace({ ...ws('MEMBER', null), isDefaultWorkspace: true }, 'workspace.viewMembers')).toBe(true);
    expect(canWorkspace({ ...ws('MEMBER', null), isDefaultWorkspace: true }, 'workspace.createChannel')).toBe(true);
  });
});

describe('invitation and join rules (Sub-batch E)', () => {
  const created = new Date('2026-11-01T00:00:00Z');
  const at = (ms: number) => created.getTime() + ms;

  it('derives the lifecycle state, including a 14-day expiry without a schema change', () => {
    expect(invitationState({ status: 'pending', createdAt: created }, at(1000))).toBe('pending');
    expect(invitationState({ status: 'pending', createdAt: created }, at(INVITATION_TTL_MS - 1))).toBe('pending');
    expect(invitationState({ status: 'pending', createdAt: created }, at(INVITATION_TTL_MS))).toBe('expired');
    expect(invitationState({ status: 'accepted', createdAt: created }, at(1000))).toBe('accepted');
    expect(invitationState({ status: 'revoked', createdAt: created }, at(1000))).toBe('revoked');
    expect(invitationState({ status: 'weird-legacy-value', createdAt: created }, at(1000))).toBe('revoked');
    expect(INVITATION_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('acceptance: state first, then the inviter must still manage, then the right (active) account', () => {
    const ok = { state: 'pending' as const, inviteeEmail: 'Ann@Example.com ', accountEmail: 'ann@example.com', accountActive: true, inviterCanManage: true };
    expect(invitationAcceptanceDenial(ok)).toBeNull(); // case/whitespace-insensitive
    expect(invitationAcceptanceDenial({ ...ok, state: 'accepted' })).toBe('used');
    expect(invitationAcceptanceDenial({ ...ok, state: 'revoked' })).toBe('revoked');
    expect(invitationAcceptanceDenial({ ...ok, state: 'expired' })).toBe('expired');
    expect(invitationAcceptanceDenial({ ...ok, inviterCanManage: false })).toBe('inviterLostAccess');
    expect(invitationAcceptanceDenial({ ...ok, accountEmail: 'mallory@example.com' })).toBe('wrongAccount');
    expect(invitationAcceptanceDenial({ ...ok, accountActive: false })).toBe('inactiveAccount');
    // An expired invitation is reported as expired even to the wrong account.
    expect(invitationAcceptanceDenial({ ...ok, state: 'expired', accountEmail: 'x@y.z' })).toBe('expired');
  });

  it('only active accounts join workspaces; group DM removal is self or creator', () => {
    expect(canJoinWorkspaces({ status: 'ACTIVE' })).toBe(true);
    expect(canJoinWorkspaces({ status: 'SUSPENDED' })).toBe(false);
    expect(canJoinWorkspaces({ status: 'BANNED' })).toBe(false);
    expect(normalizeEmail('  MiXeD@Example.COM ')).toBe('mixed@example.com');
    expect(canRemoveGroupDMParticipant('a', 'a', 'creator')).toBe(true);
    expect(canRemoveGroupDMParticipant('creator', 'b', 'creator')).toBe(true);
    expect(canRemoveGroupDMParticipant('a', 'b', 'creator')).toBe(false);
  });
});
