import { Plus, Settings, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button } from '../../components/ui';
import { CreateWorkspaceModal } from '../../components/sidebar/CreateWorkspaceModal';
import { useHierarchy } from '../../hooks/useHierarchy';
import { useWorkspaces } from './WorkspacesProvider';

/**
 * Stage 3 (T.22) — "My Workspaces": the team workspaces this person runs
 * (owner or admin), with member counts and a way in to manage members,
 * invitations and settings; Team Leads can create another one here.
 * Visibility only — every action is authorized by the server.
 */
export const MyWorkspacesPage = () => {
  const { workspaces } = useWorkspaces();
  const hierarchy = useHierarchy();
  const [creating, setCreating] = useState(false);
  const managed = workspaces.filter((w) => !w.isDefault && w.capabilities?.canManage);
  const canCreate = hierarchy?.canCreateWorkspaces === true;

  return (
    <div className="h-full overflow-y-auto bg-surface-secondary p-4 sm:p-8">
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-fg tracking-tight">My Workspaces</h1>
          <p className="text-sm text-fg-muted mt-1">The team workspaces you run. Add members, manage invitations and settings from each one.</p>
        </div>
        {canCreate && (
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setCreating(true)}>
            Create workspace
          </Button>
        )}
      </header>

      {managed.length === 0 ? (
        <div className="bg-surface border border-line rounded-2xl p-8 text-center text-sm text-fg-muted">
          You don't manage any team workspaces yet.{canCreate ? ' Create one to get your team started.' : ''}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {managed.map((w) => {
            const members = w._count?.members ?? 0;
            return (
              <article key={w.id} aria-label={w.name} className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-base font-bold text-fg truncate">{w.name}</h2>
                  <Badge tone="brand">{w.isOwner ? 'Owner' : 'Admin'}</Badge>
                </div>
                {w.description && <p className="text-sm text-fg-muted line-clamp-2">{w.description}</p>}
                <p className="text-xs text-fg-subtle flex items-center gap-1.5">
                  <Users size={13} aria-hidden="true" />
                  {`${members} member${members === 1 ? '' : 's'}`}
                  {w.organization && !w.organization.isDefault ? ` · ${w.organization.name}` : ''}
                </p>
                <div className="flex gap-2 mt-auto pt-1">
                  <Link to={`/${w.id}`} className="inline-flex items-center h-8 px-3 rounded-lg border border-line text-xs font-semibold text-fg hover:bg-surface-secondary">
                    Open
                  </Link>
                  <Link
                    to={`/${w.id}/settings?tab=members`}
                    aria-label={`Manage ${w.name}`}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-brand text-white text-xs font-semibold"
                  >
                    <Settings size={13} aria-hidden="true" /> Manage
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <CreateWorkspaceModal isOpen={creating} onClose={() => setCreating(false)} />
    </div>
  );
};
