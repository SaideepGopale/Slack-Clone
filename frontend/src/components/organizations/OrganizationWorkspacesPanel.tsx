import { LayoutGrid, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { organizationWorkspaceActions } from '../../lib/adminAccess';
import type { OrganizationDetails } from '../../lib/api';
import { useWorkspaces } from '../../pages/workspace/WorkspacesProvider';
import { useSwitchWorkspace } from '../../pages/workspace/useWorkspaceActions';
import { RoleBadge } from '../management/RoleBadge';
import { CreateWorkspaceModal } from '../sidebar/CreateWorkspaceModal';
import { Badge, Button, EmptyState } from '../ui';

interface OrganizationWorkspacesPanelProps {
  organization: OrganizationDetails;
  layoutWorkspaceId: string;
}

/**
 * The organization's workspaces. Members see the ones they belong to;
 * organization OWNER/ADMINs see all of them (server-filtered) and can manage
 * each one — "Open" (content) stays reserved for actual members.
 */
export const OrganizationWorkspacesPanel = ({ organization, layoutWorkspaceId }: OrganizationWorkspacesPanelProps) => {
  const navigate = useNavigate();
  const { refresh } = useWorkspaces();
  const { switchTo, dialog } = useSwitchWorkspace();
  const [creating, setCreating] = useState(false);

  const managePath = (workspaceId: string) =>
    workspaceId === layoutWorkspaceId
      ? `/${layoutWorkspaceId}/settings`
      : `/${layoutWorkspaceId}/organizations/${organization.id}/workspaces/${workspaceId}`;

  return (
    <div className="space-y-4">
      {dialog}
      {organization.capabilities.canCreateWorkspace && (
        <div className="flex justify-end">
          <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => setCreating(true)}>
            New workspace
          </Button>
        </div>
      )}
      {organization.workspaces.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid size={28} aria-hidden="true" />}
          title="No workspaces yet"
          description={
            organization.capabilities.canCreateWorkspace
              ? 'Create the first workspace of this organization.'
              : 'Workspaces you belong to in this organization appear here.'
          }
        />
      ) : (
        <ul aria-label={`Workspaces in ${organization.name}`} className="divide-y divide-line border border-line rounded-xl overflow-hidden">
          {organization.workspaces.map((ws) => {
            const { canOpen, canManage } = organizationWorkspaceActions(organization, ws);
            const isCurrent = ws.id === layoutWorkspaceId;
            return (
              <li key={ws.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-fg break-words">{ws.name}</span>
                    {ws.isDefault && <Badge tone="brand">Default</Badge>}
                    {ws.myRole ? <RoleBadge role={ws.myRole} /> : <Badge>Not a member</Badge>}
                    {isCurrent && <Badge tone="success">Current</Badge>}
                  </div>
                  {ws.description && <p className="text-sm text-fg-muted mt-1 break-words">{ws.description}</p>}
                </div>
                <div className="flex gap-2 shrink-0">
                  {canManage && (
                    <Button size="sm" variant="secondary" onClick={() => navigate(managePath(ws.id))} aria-label={`${ws.isMember ? 'Settings for' : 'Manage'} ${ws.name}`}>
                      {ws.isMember ? 'Settings' : 'Manage'}
                    </Button>
                  )}
                  {canOpen && !isCurrent && (
                    <Button size="sm" onClick={() => switchTo(ws.id)} aria-label={`Open ${ws.name}`}>
                      Open
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <CreateWorkspaceModal
        isOpen={creating}
        organization={{ id: organization.id, name: organization.name }}
        onClose={() => setCreating(false)}
        onCreated={() => refresh().catch(() => undefined)}
      />
    </div>
  );
};
