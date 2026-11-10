import { Search, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'react-toastify';
import type { Socket } from 'socket.io-client';
import { usePagedSearch } from '../../hooks/usePagedSearch';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { canChangeOrganizationMemberRole, canRemoveOrganizationMember } from '../../lib/adminAccess';
import { errorMessage, organizationsApi } from '../../lib/api';
import type { OrganizationDetails, OrganizationMember } from '../../lib/api';
import { AccessProblem } from '../management/AccessProblem';
import { RoleBadge } from '../management/RoleBadge';
import { Badge, Button, EmptyState, LoadingState, Spinner, TextInput, useConfirm } from '../ui';

interface OrganizationMembersPanelProps {
  organization: OrganizationDetails;
  viewerId: string | undefined;
  socket: Socket | null;
}

const selectClass =
  'bg-surface border border-line rounded-lg px-2 py-1 text-xs font-semibold text-fg outline-none focus:border-brand focus:ring-2 focus:ring-brand-muted disabled:opacity-50';

/**
 * Organization members: explicit members and people who belong through one
 * of its workspaces. Only the organization OWNER changes roles (ADMIN ⇄
 * MEMBER; ownership transfer isn't supported by the backend). Removal detaches
 * the person from every workspace of the organization.
 */
export const OrganizationMembersPanel = ({ organization, viewerId, socket }: OrganizationMembersPanelProps) => {
  const members = usePagedSearch<OrganizationMember>(
    (q, cursor) => organizationsApi.listOrganizationMembers(organization.id, { q, cursor, limit: 50 }),
    organization.id
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const isManager = organization.capabilities.canUpdate;

  useSocketEvent<{ organizationId: string; userId: string; role: 'ADMIN' | 'MEMBER' }>(socket, 'organization:member_updated', (payload) => {
    if (payload.organizationId !== organization.id) return;
    members.setItems((prev) => prev.map((m) => (m.id === payload.userId ? { ...m, role: payload.role, explicit: true } : m)));
  });

  const changeRole = async (member: OrganizationMember, role: 'ADMIN' | 'MEMBER') => {
    if (role === member.role) return;
    setBusyId(member.id);
    try {
      await organizationsApi.changeOrganizationRole(organization.id, member.id, role);
      members.setItems((prev) => prev.map((m) => (m.id === member.id ? { ...m, role, explicit: true } : m)));
      toast.success(`${member.username} is now ${role === 'ADMIN' ? 'an organization admin' : 'an organization member'}.`);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not change the role.'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (member: OrganizationMember) => {
    const confirmed = await confirm({
      title: `Remove ${member.username} from ${organization.name}?`,
      message: 'They are removed from every workspace in this organization and lose access immediately.',
      confirmLabel: 'Remove from organization',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusyId(member.id);
    try {
      const result = await organizationsApi.removeOrganizationMember(organization.id, member.id);
      members.setItems((prev) => prev.filter((m) => m.id !== member.id));
      toast.success(
        result.workspaces > 0
          ? `${member.username} was removed (and from ${result.workspaces} workspace${result.workspaces === 1 ? '' : 's'}).`
          : `${member.username} was removed.`
      );
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove this member.'));
    } finally {
      setBusyId(null);
    }
  };

  if (members.error && members.items.length === 0 && !members.loading) {
    return <AccessProblem error={members.error} resource="organization" onRetry={members.refresh} />;
  }

  return (
    <div className="space-y-4">
      {dialog}
      <div className="relative">
        <Search size={16} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <TextInput
          type="search"
          aria-label="Search organization members"
          placeholder={isManager ? 'Search by name or e-mail' : 'Search by name'}
          value={members.query}
          onChange={(e) => members.setQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      <p className="text-xs text-fg-muted">
        {organization.capabilities.canChangeRoles
          ? 'As the owner you can make members admins. Ownership can’t be transferred yet.'
          : 'Only the organization owner can change roles.'}
      </p>
      {members.loading ? (
        <LoadingState label="Loading organization members" />
      ) : members.items.length === 0 ? (
        <EmptyState icon={<Users size={28} aria-hidden="true" />} title={members.query ? 'No matching members' : 'No members yet'} />
      ) : (
        <ul aria-label="Organization members" className="divide-y divide-line border border-line rounded-xl overflow-hidden">
          {members.items.map((member) => {
            const editableRole = canChangeOrganizationMemberRole(organization, member, viewerId);
            const removable = canRemoveOrganizationMember(organization, member, viewerId);
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
                      <RoleBadge role={member.role} />
                      {!member.explicit && <Badge>Via workspace</Badge>}
                    </div>
                    {isManager && <div className="text-xs text-fg-muted truncate">{member.email}</div>}
                  </div>
                </div>
                {(editableRole || removable) && (
                  <div className="flex items-center gap-2 shrink-0">
                    {busy && <Spinner size={14} label="Saving" />}
                    {editableRole && (
                      <select
                        aria-label={`Organization role for ${member.username}`}
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
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => remove(member)} aria-label={`Remove ${member.username} from organization`}>
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
    </div>
  );
};
