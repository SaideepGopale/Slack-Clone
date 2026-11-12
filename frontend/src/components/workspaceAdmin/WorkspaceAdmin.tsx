import { LogOut, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { workspaceAdminAccess } from '../../lib/adminAccess';
import { workspacesApi } from '../../lib/api';
import type { WorkspaceSettings } from '../../lib/api';
import type { WorkspaceUpdatedPayload } from '../../lib/workspaces';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { useWorkspaces } from '../../pages/workspace/WorkspacesProvider';
import { useLeaveWorkspace } from '../../pages/workspace/useWorkspaceActions';
import { AccessProblem } from '../management/AccessProblem';
import { Crumb, PageFrame, Section } from '../management/PageFrame';
import { RoleBadge } from '../management/RoleBadge';
import { DeleteWorkspaceModal } from '../sidebar/DeleteWorkspaceModal';
import { Badge, Button, LoadingState, TabPanel, Tabs } from '../ui';
import { GeneralSettingsPanel } from './GeneralSettingsPanel';
import { InvitationsPanel } from './InvitationsPanel';
import { JoinRequestsPanel } from './JoinRequestsPanel';
import { WorkspaceMembersPanel } from './WorkspaceMembersPanel';

type TabId = 'general' | 'members' | 'invitations' | 'requests';

interface WorkspaceAdminProps {
  /** The workspace being administered. */
  workspaceId: string;
  /**
   * The workspace whose layout we're rendered in (the URL's /:workspaceId).
   * Different from `workspaceId` when an organization admin manages a
   * workspace from the organization page — possibly without being a member.
   */
  layoutWorkspaceId: string;
}

/**
 * Workspace administration (F2): General (details, policy, leave/delete),
 * Members (roles, removal), Invitations and Join requests. Uses only the
 * management endpoints (settings, members, invitations), never the
 * workspace's channels or messages — so an organization admin can manage a
 * workspace without gaining access to its content.
 */
export const WorkspaceAdmin = ({ workspaceId, layoutWorkspaceId }: WorkspaceAdminProps) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { socket } = useWorkspace();
  const { getWorkspace, applyUpdated } = useWorkspaces();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showDelete, setShowDelete] = useState(false);
  const { leave, dialog: leaveDialog } = useLeaveWorkspace();
  const isCurrent = workspaceId === layoutWorkspaceId;

  // No room events reach organization admins who aren't members, so the
  // settings also refresh on focus.
  const settings = useApiQuery<WorkspaceSettings>(() => workspacesApi.getWorkspaceSettings(workspaceId), [workspaceId], { refetchOnFocus: true });
  const data = settings.data;
  const organizationId = data?.organization?.id;
  const organizationPath = organizationId ? `/${layoutWorkspaceId}/organizations/${organizationId}` : null;

  // Leaving the page after the workspace is gone (left, deleted, removed).
  const afterGone = useCallback(() => {
    if (isCurrent) navigate('/', { replace: true });
    else navigate(organizationPath ?? `/${layoutWorkspaceId}/organizations`, { replace: true });
  }, [isCurrent, navigate, organizationPath, layoutWorkspaceId]);

  // ── Live updates ──────────────────────────────────────────────────────
  useSocketEvent<WorkspaceUpdatedPayload>(socket, 'workspace:updated', (payload) => {
    if (payload.id !== workspaceId) return;
    settings.setData((prev) =>
      prev
        ? {
            ...prev,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.description !== undefined ? { description: payload.description } : {}),
            ...(payload.channelCreationPolicy !== undefined ? { channelCreationPolicy: payload.channelCreationPolicy } : {}),
          }
        : prev
    );
  });
  const onMyRoleChanged = (payload: { userId?: string }) => {
    if (payload.userId && payload.userId === user?.id) settings.reload({ silent: true }).catch(() => undefined);
  };
  useSocketEvent<{ workspaceId: string; userId: string }>(socket, 'workspace:member_updated', (payload) => {
    if (payload.workspaceId === workspaceId) onMyRoleChanged(payload);
  });
  useSocketEvent<{ organizationId: string; userId: string }>(socket, 'organization:member_updated', (payload) => {
    if (payload.organizationId === organizationId) onMyRoleChanged(payload);
  });
  useSocketEvent<{ id: string; name: string }>(socket, 'organization:updated', (payload) => {
    if (payload.id !== organizationId) return;
    settings.setData((prev) => (prev && prev.organization ? { ...prev, organization: { ...prev.organization, name: payload.name } } : prev));
  });
  // The current workspace is handled by WorkspaceLayout (it navigates to "/").
  useSocketEvent<{ workspaceId: string; reason: string }>(socket, 'workspace:removed', (payload) => {
    if (isCurrent || payload.workspaceId !== workspaceId) return;
    toast.info(
      payload.reason === 'deleted' ? 'That workspace was deleted.' : payload.reason === 'left' ? 'You left that workspace.' : 'You no longer belong to that workspace.'
    );
    settings.reload({ silent: true }).catch(() => undefined); // an organization admin may still manage it
  });
  useSocketEvent<{ organizationId: string }>(socket, 'organization:removed', (payload) => {
    if (isCurrent || payload.organizationId !== organizationId) return;
    toast.info('You were removed from that organization.');
    navigate(`/${layoutWorkspaceId}/organizations`, { replace: true });
  });

  const crumbsFor = (name: string): Crumb[] =>
    isCurrent
      ? [{ label: name, to: `/${layoutWorkspaceId}` }, { label: 'Settings' }]
      : [
          { label: 'Organizations', to: `/${layoutWorkspaceId}/organizations` },
          ...(data?.organization && organizationPath ? [{ label: data.organization.name, to: organizationPath }] : []),
          { label: name },
        ];

  if (!data) {
    return (
      <PageFrame title="Workspace settings" crumbs={isCurrent ? [{ label: 'Settings' }] : [{ label: 'Organizations', to: `/${layoutWorkspaceId}/organizations` }]}>
        {settings.error ? (
          <AccessProblem
            error={settings.error}
            resource="workspace"
            onRetry={() => settings.reload()}
            action={
              <Button variant="secondary" onClick={() => navigate(`/${layoutWorkspaceId}/organizations`)}>
                Back to organizations
              </Button>
            }
          />
        ) : (
          <LoadingState label="Loading workspace settings" />
        )}
      </PageFrame>
    );
  }

  const access = workspaceAdminAccess(data, getWorkspace(workspaceId));
  const tabs = [
    { id: 'general' as const, label: 'General' },
    { id: 'members' as const, label: 'Members', count: data._count.members },
    ...(access.canManageInvitations
      ? [
          { id: 'invitations' as const, label: 'Invitations' },
          { id: 'requests' as const, label: 'Join requests' },
        ]
      : []),
  ];
  const requested = searchParams.get('tab') as TabId | null;
  const tab: TabId = tabs.some((t) => t.id === requested) ? (requested as TabId) : 'general';
  const setTab = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id === 'general') next.delete('tab');
    else next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  const onSaved = (updated: WorkspaceSettings) => {
    settings.setData(updated);
    applyUpdated({ id: updated.id, name: updated.name, description: updated.description, channelCreationPolicy: updated.channelCreationPolicy });
  };

  return (
    <PageFrame
      eyebrow={isCurrent ? 'Workspace settings' : 'Manage workspace'}
      title={data.name}
      crumbs={crumbsFor(data.name)}
      badges={
        <>
          {data.myRole ? <RoleBadge role={data.myRole} /> : <Badge>Not a member</Badge>}
          {data.isDefault && <Badge tone="brand">Default</Badge>}
        </>
      }
    >
      {leaveDialog}
      {!access.isMember && access.isOrganizationManager && (
        <p className="mb-4 rounded-xl bg-brand-soft p-3 text-sm text-fg-muted">
          You manage this workspace as an organization admin. Its channels and messages are visible only to its members.
        </p>
      )}
      <Tabs label="Workspace settings sections" tabs={tabs} value={tab} onChange={setTab} idPrefix="workspace-admin" className="mb-6 overflow-x-auto" />
      <TabPanel idPrefix="workspace-admin" id={tab} className="outline-none">
        {tab === 'general' && (
          <div className="space-y-6">
            <GeneralSettingsPanel settings={data} access={access} organizationPath={organizationPath} onSaved={onSaved} />
            {(access.canLeave || access.canDelete) && (
              <Section title="Danger zone" tone="danger">
                <div className="flex flex-col gap-4">
                  {access.canLeave && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-fg-muted">Leave this workspace. You'll need a new invitation to come back.</p>
                      <Button variant="secondary" icon={<LogOut size={14} aria-hidden="true" />} onClick={() => leave({ id: data.id, name: data.name }, afterGone)}>
                        Leave workspace
                      </Button>
                    </div>
                  )}
                  {access.canDelete && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-fg-muted">Permanently delete this workspace, its channels and its messages.</p>
                      <Button variant="danger" icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => setShowDelete(true)}>
                        Delete workspace
                      </Button>
                    </div>
                  )}
                </div>
              </Section>
            )}
          </div>
        )}
        {tab === 'members' && <WorkspaceMembersPanel workspaceId={workspaceId} settings={data} access={access} viewerId={user?.id} socket={socket} />}
        {tab === 'invitations' && access.canManageInvitations && <InvitationsPanel workspaceId={workspaceId} emailInvitationsAvailable={data.emailInvitationsAvailable ?? true} />}
        {tab === 'requests' && access.canManageInvitations && <JoinRequestsPanel workspaceId={workspaceId} />}
      </TabPanel>
      <DeleteWorkspaceModal
        isOpen={showDelete}
        onClose={() => setShowDelete(false)}
        workspaceId={data.id}
        workspaceName={data.name}
        onDeleted={afterGone}
      />
    </PageFrame>
  );
};
