import { describe, expect, it } from 'vitest';
import {
  canOrganization,
  canSeeOrganizationMemberEmails,
  canSeeWorkspaceMemberEmails,
  canWorkspace,
  OrganizationActor,
  OrganizationRoleName,
  visibleEmail,
  WorkspaceActor,
  WorkspaceRoleName,
} from '../lib/policy';

/**
 * P1-D — FA-SEC-03: who may see other members' e-mail addresses (lib/policy,
 * database-free). The rule is the one the F2 admin panels already applied in
 * the UI — now the API's rule too.
 */

const ws = (workspaceRole: WorkspaceRoleName | null, organizationRole: OrganizationRoleName | null, isDefaultWorkspace = false): WorkspaceActor => ({
  userId: 'actor',
  workspaceId: 'ws',
  organizationId: 'org',
  isDefaultWorkspace,
  channelCreationPolicy: 'MEMBERS',
  workspaceRole,
  organizationRole,
});

const org = (role: OrganizationRoleName | null, implicit = false, isDefaultOrganization = false): OrganizationActor => ({
  userId: 'actor',
  organizationId: 'org',
  isDefaultOrganization,
  role,
  implicit,
});

const WS_ROLES: (WorkspaceRoleName | null)[] = ['OWNER', 'ADMIN', 'MEMBER', null];
const ORG_ROLES: (OrganizationRoleName | null)[] = ['OWNER', 'ADMIN', 'MEMBER', null];

describe('canSeeWorkspaceMemberEmails (FA-SEC-03)', () => {
  // [workspace role, organization role, sees other members' e-mails]
  const rows: [WorkspaceRoleName | null, OrganizationRoleName | null, boolean][] = [
    ['OWNER', null, true],
    ['ADMIN', null, true],
    ['MEMBER', null, false],
    ['MEMBER', 'MEMBER', false],
    ['MEMBER', 'ADMIN', true], // organization managers manage every workspace of the organization
    ['MEMBER', 'OWNER', true],
    [null, 'OWNER', true],
    [null, 'ADMIN', true],
    [null, 'MEMBER', false],
    [null, null, false],
  ];
  it.each(rows)('workspace %s / organization %s → %s', (workspaceRole, organizationRole, expected) => {
    expect(canSeeWorkspaceMemberEmails(ws(workspaceRole, organizationRole))).toBe(expected);
  });

  it('is exactly the workspace settings permission the F2 members panel uses (canEditSettings)', () => {
    for (const w of WS_ROLES) {
      for (const o of ORG_ROLES) {
        const actor = ws(w, o);
        expect(canSeeWorkspaceMemberEmails(actor), `${w}/${o}`).toBe(canWorkspace(actor, 'workspace.updateSettings'));
      }
    }
  });

  it('the Default Workspace grants no e-mail visibility by itself', () => {
    expect(canSeeWorkspaceMemberEmails(ws('MEMBER', null, true))).toBe(false);
    expect(canSeeWorkspaceMemberEmails(ws('MEMBER', 'MEMBER', true))).toBe(false);
  });
});

describe('canSeeOrganizationMemberEmails (FA-SEC-03)', () => {
  it('explicit organization owners and admins only — never members, never implicit membership', () => {
    expect(canSeeOrganizationMemberEmails(org('OWNER'))).toBe(true);
    expect(canSeeOrganizationMemberEmails(org('ADMIN'))).toBe(true);
    expect(canSeeOrganizationMemberEmails(org('MEMBER'))).toBe(false);
    expect(canSeeOrganizationMemberEmails(org('MEMBER', true))).toBe(false); // derived from a workspace
    expect(canSeeOrganizationMemberEmails(org('MEMBER', true, true))).toBe(false); // every account in the Default Organization
    expect(canSeeOrganizationMemberEmails(org(null))).toBe(false);
  });

  it('is exactly the organization permission the F2 members panel uses (capabilities.canUpdate)', () => {
    for (const role of ORG_ROLES) {
      for (const implicit of [false, true]) {
        const actor = org(role, implicit);
        expect(canSeeOrganizationMemberEmails(actor), `${role}/${implicit}`).toBe(canOrganization(actor, 'organization.update'));
      }
    }
  });
});

describe('visibleEmail (FA-SEC-03)', () => {
  const member = { id: 'm1', email: 'm1@example.test' };

  it('managers see the e-mail', () => {
    expect(visibleEmail({ id: 'manager', canSeeEmails: true }, member)).toBe('m1@example.test');
  });

  it('everyone sees their own e-mail', () => {
    expect(visibleEmail({ id: 'm1', canSeeEmails: false }, member)).toBe('m1@example.test');
  });

  it('nobody else does — the field is left out entirely', () => {
    expect(visibleEmail({ id: 'peer', canSeeEmails: false }, member)).toBeUndefined();
    expect(JSON.stringify({ ...member, email: visibleEmail({ id: 'peer', canSeeEmails: false }, member) })).toBe('{"id":"m1"}');
  });
});
