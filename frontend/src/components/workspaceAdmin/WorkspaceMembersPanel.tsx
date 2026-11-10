import { MailPlus, Search, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import type { Socket } from 'socket.io-client';
import { useHierarchy } from '../../hooks/useHierarchy';
import { usePagedSearch } from '../../hooks/usePagedSearch';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import {
  canChangeWorkspaceMemberRole,
  canRemoveWorkspaceMember,
  formatDate,
  workspaceMemberRole,
  WorkspaceAdminAccess,
} from '../../lib/adminAccess';
import { errorMessage, workspacesApi } from '../../lib/api';
import type { WorkspaceSettings } from '../../lib/api';
import type { MemberProvisionResult } from '../../lib/api/teamManagement';
import type { WorkspaceMember } from '../../types';
import { AccessProblem } from '../management/AccessProblem';
import { RoleBadge } from '../management/RoleBadge';
import { Button, EmptyState, LoadingState, OneTimeCredentialsModal, Spinner, TextInput, useConfirm } from '../ui';
import { AddMembersModal } from './AddMembersModal';
import { AddTeamMemberModal } from './AddTeamMemberModal';
import { MemberActivationsPanel } from './MemberActivationsPanel';

interface WorkspaceMembersPanelProps {
  workspaceId: string;
  settings: WorkspaceSettings;
  access: WorkspaceAdminAccess;
  viewerId: string | undefined;
  socket: Socket | null;
  /** Bumped by the parent to force a refresh (e.g. after approving a join request). */
  refreshKey?: number;
}

const selectClass =
  'bg-surface border border-line rounded-lg px-2 py-1 text-xs font-semibold text-fg outline-none focus:border-brand focus:ring-2 focus:ring-brand-muted disabled:opacity-50';

/**
 * Workspace members with role management. Role and removal controls appear
 * only where lib/policy would allow them (adminAccess.ts); the server decides.
 * Live: `workspace:member_updated` patches roles in place. Joins and removals
 * have no room event, so the list also refreshes on focus.
 */
export const WorkspaceMembersPanel = ({ workspaceId, settings, access, viewerId, socket, refreshKey = 0 }: WorkspaceMembersPanelProps) => {
  const members = usePagedSearch<WorkspaceMember>(
    (q, cursor) => workspacesApi.listWorkspaceMembers(workspaceId, { q, cursor, limit: 50 }),
    `${workspaceId}:${refreshKey}`
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Stage 3 (T.22): Team Leads provision new Members into workspaces they manage.
  const hierarchy = useHierarchy();
  const canProvision = access.canManageInvitations && hierarchy?.canProvisionMembers === true;
  const [addingNew, setAddingNew] = useState(false);
  const [provisioned, setProvisioned] = useState<MemberProvisionResult | null>(null);
  const [activationsKey, setActivationsKey] = useState(0);
  const { confirm, dialog } = useConfirm();
  const showEmails = access.canEditSettings;

  useSocketEvent<{ workspaceId: string; userId: string; role: 'ADMIN' | 'MEMBER' }>(socket, 'workspace:member_updated', (payload) => {
    if (payload.workspaceId !== workspaceId) return;
    members.setItems((prev) => prev.map((m) => (m.id === payload.userId ? { ...m, role: payload.role } : m)));
  });

  const { refresh } = members;
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const changeRole = async (member: WorkspaceMember, role: 'ADMIN' | 'MEMBER') => {
    if (role === member.role) return;
    setBusyId(member.id);
    try {
      await workspacesApi.changeWorkspaceRole(workspaceId, member.id, role);
      members.setItems((prev) => prev.map((m) => (m.id === member.id ? { ...m, role } : m)));
      toast.success(`${member.username} is now ${role === 'ADMIN' ? 'an admin' : 'a member'}.`);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not change the role.'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (member: WorkspaceMember) => {
    const confirmed = await confirm({
      title: `Remove ${member.username}?`,
      message: `They lose access to ${settings.name} immediately, including its channels and conversations. They'll need a new invitation to come back.`,
      confirmLabel: 'Remove from workspace',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusyId(member.id);
    try {
      await workspacesApi.removeWorkspaceMember(workspaceId, member.id);
      members.setItems((prev) => prev.filter((m) => m.id !== member.id));
      toast.success(`${member.username} was removed.`);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove this member.'));
    } finally {
      setBusyId(null);
    }
  };

  if (members.error && members.items.length === 0 && !members.loading) {
    return <AccessProblem error={members.error} resource="workspace" onRetry={refresh} />;
  }

  return (
    <div className="space-y-4">
      {dialog}
      {adding && <AddMembersModal workspaceId={workspaceId} workspaceName={settings.name} onClose={() => setAdding(false)} onAdded={refresh} />}
      {addingNew && (
        <AddTeamMemberModal
          workspaceId={workspaceId}
          workspaceName={settings.name}
          onClose={() => setAddingNew(false)}
          onCreated={(result) => {
            setAddingNew(false);
            setProvisioned(result);
            setActivationsKey((k) => k + 1);
          }}
          onAddedExisting={() => {
            setAddingNew(false);
            refresh();
            toast.success('Added to the workspace.');
          }}
        />
      )}
      {provisioned && (
        <OneTimeCredentialsModal
          title="Member invitation"
          subtitle={`For ${provisioned.invitation.account.displayName || provisioned.invitation.account.username}. Share it privately — anyone with both the link and the temporary password can activate this account.`}
          intro={`You've been added to SmartConnect as a member of ${settings.name}.`}
          credentials={provisioned.credentials}
          onClose={() => setProvisioned(null)}
        />
      )}
      <div className="flex flex-col sm:flex-row gap-2">
      <div className="relative flex-1">
        <Search size={16} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <TextInput
          type="search"
          aria-label="Search members"
          placeholder={showEmails ? 'Search by name or e-mail' : 'Search by name'}
          value={members.query}
          onChange={(e) => members.setQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      {access.canManageInvitations && (
        <Button icon={<UserPlus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add people</Button>
      )}
      {canProvision && (
        <Button variant="secondary" icon={<MailPlus size={15} aria-hidden="true" />} onClick={() => setAddingNew(true)}>Add team member</Button>
      )}
      </div>
      {!access.canChangeRoles && !access.canRemoveMembers && (
        <p className="text-xs text-fg-muted">Only the workspace owner, workspace admins and organization admins can manage members.</p>
      )}
      {members.loading ? (
        <LoadingState label="Loading members" />
      ) : members.items.length === 0 ? (
        <EmptyState icon={<Users size={28} aria-hidden="true" />} title={members.query ? 'No matching members' : 'No members yet'} />
      ) : (
        <ul aria-label="Workspace members" className="divide-y divide-line border border-line rounded-xl overflow-hidden">
          {members.items.map((member) => {
            const role = workspaceMemberRole(member);
            const editableRole = canChangeWorkspaceMemberRole(access, member, viewerId);
            const removable = canRemoveWorkspaceMember(access, settings, member, viewerId);
            const busy = busyId === member.id;
            return (
              <li key={member.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div aria-hidden="true" className="w-8 h-8 rounded-full bg-brand-soft text-brand flex items-center justify-center font-black text-xs shrink-0">
                    {member.username.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-sm text-fg truncate">{member.username}</span>
                      {member.id === viewerId && <span className="text-xs text-fg-subtle">(you)</span>}
                      <RoleBadge role={role} />
                    </div>
                    <div className="text-xs text-fg-muted truncate">
                      {showEmails ? `${member.email} · ` : ''}joined {formatDate(member.joinedAt)}
                    </div>
                  </div>
                </div>
                {(editableRole || removable) && (
                  <div className="flex items-center gap-2 shrink-0">
                    {busy && <Spinner size={14} label="Saving" />}
                    {editableRole && (
                      <select
                        aria-label={`Role for ${member.username}`}
                        value={member.role}
                        disabled={busy}
                        onChange={(e) => changeRole(member, e.target.value as 'ADMIN' | 'MEMBER')}
                        className={selectClass}
                      >
                        <option value="ADMIN">Admin</option>
                        <option value="MEMBER">Member</option>
                      </select>
                    )}
                    {removable && (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => remove(member)} aria-label={`Remove ${member.username}`}>
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {members.hasMore && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={members.loadMore} loading={members.loadingMore}>
            Load more
          </Button>
        </div>
      )}
      {canProvision && <MemberActivationsPanel workspaceId={workspaceId} refreshKey={activationsKey} />}
    </div>
  );
};
