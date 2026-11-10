import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { AccessProblem } from '../../components/management/AccessProblem';
import { PageFrame } from '../../components/management/PageFrame';
import { RoleBadge } from '../../components/management/RoleBadge';
import { OrganizationMembersPanel } from '../../components/organizations/OrganizationMembersPanel';
import { OrganizationSettingsPanel } from '../../components/organizations/OrganizationSettingsPanel';
import { OrganizationSwitcher } from '../../components/organizations/OrganizationSwitcher';
import { OrganizationWorkspacesPanel } from '../../components/organizations/OrganizationWorkspacesPanel';
import { Badge, Button, LoadingState, TabPanel, Tabs } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { organizationsApi } from '../../lib/api';
import type { OrganizationDetails } from '../../lib/api';
import type { WorkspaceUpdatedPayload } from '../../lib/workspaces';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { useWorkspaces } from '../workspace/WorkspacesProvider';

type TabId = 'workspaces' | 'members' | 'settings';

/**
 * /:workspaceId/organizations/:organizationId — overview (workspaces),
 * members and settings. A non-member gets the backend's 404, shown as "not
 * found" so an organization's existence isn't revealed.
 */
export const OrganizationPage = () => {
  const { organizationId = '' } = useParams<{ organizationId: string }>();
  const { workspaceId, socket } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { applyOrganizationUpdated } = useWorkspaces();
  const [searchParams, setSearchParams] = useSearchParams();
  // Workspace changes in the organization don't reach managers who aren't
  // members of them, so this also refreshes on focus.
  const organization = useApiQuery<OrganizationDetails>(() => organizationsApi.getOrganization(organizationId), [organizationId], {
    refetchOnFocus: true,
  });
  const organizations = useApiQuery(() => organizationsApi.listOrganizations(), []);
  const org = organization.data;

  // ── Live updates ──────────────────────────────────────────────────────
  useSocketEvent<{ id: string; name: string }>(socket, 'organization:updated', (payload) => {
    if (payload.id === organizationId) organization.setData((prev) => (prev ? { ...prev, name: payload.name } : prev));
    organizations.setData((prev) => prev?.map((o) => (o.id === payload.id ? { ...o, name: payload.name } : o)));
  });
  useSocketEvent<{ organizationId: string; userId: string }>(socket, 'organization:member_updated', (payload) => {
    if (payload.organizationId === organizationId && payload.userId === user?.id) {
      organization.reload({ silent: true }).catch(() => undefined); // my capabilities changed
      organizations.reload({ silent: true }).catch(() => undefined);
    }
  });
  useSocketEvent<{ organizationId: string }>(socket, 'organization:removed', (payload) => {
    if (payload.organizationId !== organizationId) return;
    toast.info('You were removed from that organization.');
    navigate(`/${workspaceId}/organizations`, { replace: true });
  });
  useSocketEvent<WorkspaceUpdatedPayload>(socket, 'workspace:updated', (payload) => {
    organization.setData((prev) =>
      prev && prev.workspaces.some((w) => w.id === payload.id)
        ? {
            ...prev,
            workspaces: prev.workspaces.map((w) =>
              w.id === payload.id
                ? { ...w, ...(payload.name !== undefined ? { name: payload.name } : {}), ...(payload.description !== undefined ? { description: payload.description } : {}) }
                : w
            ),
          }
        : prev
    );
  });
  useSocketEvent<{ workspaceId: string }>(socket, 'workspace:removed', (payload) => {
    if (org?.workspaces.some((w) => w.id === payload.workspaceId)) organization.reload({ silent: true }).catch(() => undefined);
  });
  useSocketEvent<{ workspaceId: string; userId: string }>(socket, 'workspace:member_updated', (payload) => {
    if (payload.userId === user?.id && org?.workspaces.some((w) => w.id === payload.workspaceId)) {
      organization.reload({ silent: true }).catch(() => undefined);
    }
  });

  const crumbs = [{ label: 'Organizations', to: `/${workspaceId}/organizations` }, { label: org?.name ?? 'Organization' }];

  if (!org) {
    return (
      <PageFrame title="Organization" crumbs={crumbs}>
        {organization.error ? (
          <AccessProblem
            error={organization.error}
            resource="organization"
            onRetry={() => organization.reload()}
            action={
              <Button variant="secondary" onClick={() => navigate(`/${workspaceId}/organizations`)}>
                Back to organizations
              </Button>
            }
          />
        ) : (
          <LoadingState label="Loading organization" />
        )}
      </PageFrame>
    );
  }

  const tabs = [
    { id: 'workspaces' as const, label: 'Workspaces', count: org.workspaces.length },
    { id: 'members' as const, label: 'Members' },
    ...(org.capabilities.canUpdate ? [{ id: 'settings' as const, label: 'Settings' }] : []),
  ];
  const requested = searchParams.get('tab') as TabId | null;
  const tab: TabId = tabs.some((t) => t.id === requested) ? (requested as TabId) : 'workspaces';
  const setTab = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id === 'workspaces') next.delete('tab');
    else next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  const onRenamed = (name: string) => {
    organization.setData((prev) => (prev ? { ...prev, name } : prev));
    organizations.setData((prev) => prev?.map((o) => (o.id === org.id ? { ...o, name } : o)));
    applyOrganizationUpdated({ id: org.id, name });
  };

  return (
    <PageFrame
      eyebrow="Organization"
      title={org.name}
      crumbs={crumbs}
      badges={
        <>
          <RoleBadge role={org.myRole} />
          {org.isDefault && <Badge tone="brand">Default</Badge>}
        </>
      }
      actions={<OrganizationSwitcher organizations={organizations.data ?? []} currentId={org.id} layoutWorkspaceId={workspaceId} />}
    >
      <Tabs label="Organization sections" tabs={tabs} value={tab} onChange={setTab} idPrefix="organization" className="mb-6 overflow-x-auto" />
      <TabPanel idPrefix="organization" id={tab} className="outline-none">
        {tab === 'workspaces' && <OrganizationWorkspacesPanel organization={org} layoutWorkspaceId={workspaceId} />}
        {tab === 'members' && <OrganizationMembersPanel organization={org} viewerId={user?.id} socket={socket} />}
        {tab === 'settings' && org.capabilities.canUpdate && <OrganizationSettingsPanel organization={org} onRenamed={onRenamed} />}
      </TabPanel>
    </PageFrame>
  );
};
