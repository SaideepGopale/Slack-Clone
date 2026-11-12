import { describe, expect, it } from 'vitest';
import { pickLandingWorkspace } from './workspaceLanding';

const ws = (id: string, isDefault = false) => ({ id, isDefault });

describe('pickLandingWorkspace (P2)', () => {
  it('returns to the last active workspace when it still exists', () => {
    expect(pickLandingWorkspace([ws('collab', true), ws('team')], 'collab')).toBe('collab');
    expect(pickLandingWorkspace([ws('collab', true), ws('team')], 'team')).toBe('team');
  });
  it("otherwise prefers the person's own/shared workspaces over SmartConnect Collab", () => {
    expect(pickLandingWorkspace([ws('collab', true), ws('team'), ws('ops')], 'deleted')).toBe('team');
    expect(pickLandingWorkspace([ws('collab', true), ws('team')], null)).toBe('team');
  });
  it('falls back to Collab, and to nothing for an empty list', () => {
    expect(pickLandingWorkspace([ws('collab', true)], 'gone')).toBe('collab');
    expect(pickLandingWorkspace([], null)).toBeNull();
  });
});
