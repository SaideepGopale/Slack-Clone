import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * Stage 4 (T.23) — regression for the Stage 3 switcher: "Create a workspace"
 * must not appear while the account's level is still loading (or failed to
 * load), and only Company Admins and Team Leads ever see it.
 */
const h = vi.hoisted(() => ({ hierarchy: null as Record<string, unknown> | null }));
vi.mock('../../hooks/useHierarchy', () => ({ useHierarchy: () => h.hierarchy }));
vi.mock('../../pages/workspace/WorkspacesProvider', () => ({
  useWorkspaces: () => ({ workspaces: [{ id: 'w1', name: 'SmartConnect Collab', isDefault: true, capabilities: { canManage: false } }], loading: false, refresh: vi.fn() }),
}));
vi.mock('../../pages/workspace/useWorkspaceActions', () => ({ useSwitchWorkspace: () => vi.fn() }));
vi.mock('./CreateWorkspaceModal', () => ({ CreateWorkspaceModal: () => null }));

const renderSwitcher = () =>
  render(
    <MemoryRouter initialEntries={['/w1']}>
      <Routes>
        <Route path="/:workspaceId/*" element={<WorkspaceSwitcher />} />
      </Routes>
    </MemoryRouter>
  );
const createButton = () => screen.queryByRole('button', { name: 'Create a workspace' });

beforeEach(() => {
  h.hierarchy = null;
});

describe('WorkspaceSwitcher — Create a workspace visibility', () => {
  it('is hidden while the account level is loading (or could not be loaded)', () => {
    renderSwitcher();
    expect(createButton()).not.toBeInTheDocument();
  });

  it('is hidden from Members', () => {
    h.hierarchy = { role: 'MEMBER', canCreateWorkspaces: false, canProvisionMembers: false };
    renderSwitcher();
    expect(createButton()).not.toBeInTheDocument();
  });

  it.each([
    ['TEAM_LEAD', true],
    ['COMPANY_ADMIN', false],
  ])('is shown to a %s', (role, canProvisionMembers) => {
    h.hierarchy = { role, canCreateWorkspaces: true, canProvisionMembers };
    renderSwitcher();
    expect(createButton()).toBeInTheDocument();
  });
});
