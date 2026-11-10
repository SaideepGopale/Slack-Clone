import { describe, expect, it } from 'vitest';
import {
  assertCanCreateOrganization,
  assertCanCreateWorkspace,
  assertCanHoldElevatedRole,
  canCreateOrganizations,
  canCreateWorkspaces,
  canHoldElevatedRoles,
  HierarchyActor,
  hierarchyRoleOf,
} from '../lib/policy/hierarchy';

/** Stage 1 (T.19): the company hierarchy as pure rules — no database. */
describe('company hierarchy policy', () => {
  it('maps the platform role and tier to Company Admin, Team Lead or Member (deny by default)', () => {
    expect(hierarchyRoleOf({ platformRole: 'ADMIN', tier: null })).toBe('COMPANY_ADMIN');
    expect(hierarchyRoleOf({ platformRole: 'ADMIN', tier: 'MEMBER' })).toBe('COMPANY_ADMIN');
    expect(hierarchyRoleOf({ platformRole: 'USER', tier: 'TEAM_LEAD' })).toBe('TEAM_LEAD');
    expect(hierarchyRoleOf({ platformRole: 'USER', tier: 'MEMBER' })).toBe('MEMBER');
    expect(hierarchyRoleOf({ platformRole: 'USER', tier: null })).toBe('MEMBER');
    expect(hierarchyRoleOf({ platformRole: 'TEAM_LEAD', tier: null })).toBe('MEMBER'); // unknown platform values grant nothing
  });

  const actor = (role: HierarchyActor['role'], active = true): HierarchyActor => ({ userId: 'u', role, active });
  const rows: [HierarchyActor, boolean][] = [
    [actor('COMPANY_ADMIN'), true],
    [actor('TEAM_LEAD'), true],
    [actor('MEMBER'), false],
    [actor('COMPANY_ADMIN', false), false],
    [actor('TEAM_LEAD', false), false],
    [actor('MEMBER', false), false],
  ];

  it.each(rows)('%o: create workspaces/organizations and hold admin roles → %s', (a, allowed) => {
    expect(canCreateWorkspaces(a)).toBe(allowed);
    expect(canCreateOrganizations(a)).toBe(allowed);
    expect(canHoldElevatedRoles(a)).toBe(allowed);
  });

  it('assertions raise 403 with a message that names Team Leads', () => {
    for (const fn of [assertCanCreateWorkspace, assertCanCreateOrganization]) {
      expect(() => fn(actor('TEAM_LEAD'))).not.toThrow();
      expect(() => fn(actor('MEMBER'))).toThrow(expect.objectContaining({ status: 403, message: expect.stringMatching(/Team Lead/) }));
    }
    expect(() => assertCanHoldElevatedRole(actor('MEMBER'), 'workspace')).toThrow(
      expect.objectContaining({ status: 403, message: expect.stringMatching(/workspace admins/) })
    );
    expect(() => assertCanHoldElevatedRole(actor('TEAM_LEAD'), 'organization')).not.toThrow();
  });
});
