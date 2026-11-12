import { Building2, Globe, Plus } from 'lucide-react';
import { useState } from 'react';
import { useMatch, useNavigate, useParams } from 'react-router-dom';
import { useHierarchy } from '../../hooks/useHierarchy';
import { groupWorkspacesByAccess } from '../../lib/adminAccess';
import { useWorkspaces } from '../../pages/workspace/WorkspacesProvider';
import { useSwitchWorkspace } from '../../pages/workspace/useWorkspaceActions';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';

// The far-left, always-visible rail — distinct from (and always darker than)
// the channel-list Sidebar next to it, matching the classic Slack "double
// sidebar": this bar switches which tenant you're in, the Sidebar shows that
// tenant's channels. Deliberately outside the mobile-collapsible drawer
// wrapper in WorkspaceLayout.tsx — it's thin enough to stay put on mobile too.
//
// P2: grouped by access — SmartConnect Collab (shared with everyone), My
// workspaces (owned) and Shared with me — each labelled; every button's
// tooltip still names its organization, and the Organizations button opens
// the organization pages.
export const WorkspaceSwitcher = () => {
  const { workspaceId: activeWorkspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const onOrganizations = !!useMatch('/:workspaceId/organizations/*');
  // Shared list (F1, WorkspacesProvider) — already sorted Default-first and
  // kept live (renames, removals) instead of refetched on every switch.
  const { workspaces, refresh } = useWorkspaces();
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Stage 4 (T.23): shown only once the server confirms this account may create
  // workspaces (Company Admin or Team Lead) — hidden while loading, on error, and for Members.
  const hierarchy = useHierarchy();
  const canCreateWorkspace = hierarchy?.canCreateWorkspaces === true;
  const { switchTo, dialog } = useSwitchWorkspace();
  // P2: SmartConnect Collab, then My workspaces, then Shared with me.
  const groups = groupWorkspacesByAccess(workspaces);

  // The POST response lacks roles/capabilities — reload the authoritative list.
  const handleCreated = () => {
    refresh().catch(() => undefined);
  };

  return (
    <nav aria-label="Workspaces" className="theme-fixed w-[60px] h-full bg-sidebar border-r border-white/[0.06] flex flex-col items-center py-3 gap-2 shrink-0 overflow-y-auto no-scrollbar">
      {groups.map((group, groupIndex) => (
        <div
          key={group.key}
          role="group"
          aria-label={group.label}
          className="w-full flex flex-col items-center gap-2"
        >
          {groupIndex > 0 && <div aria-hidden="true" className="w-8 h-px bg-white/10 my-0.5 shrink-0" />}
          <div aria-hidden="true" title={group.label} className="text-[9px] font-bold uppercase tracking-wider text-sidebar-fg-muted select-none">
            {group.short}
          </div>
          {group.workspaces.map((ws) => {
            const isActive = ws.id === activeWorkspaceId;
            const name = ws.isDefault ? `${ws.name} (shared with everyone)` : ws.name;
            const tooltip = ws.organization && !ws.organization.isDefault ? `${name} · ${ws.organization.name}` : name;
            return (
              <div key={ws.id} className="relative w-full flex items-center justify-center group">
                {/* Active-workspace indicator — a white pill flush against the
                    left edge, same convention Slack uses for "you are here". */}
                <div
                  className={`absolute left-0 w-[3px] rounded-r-full bg-accent-300 transition-all duration-200 ${
                    isActive ? 'h-7' : 'h-0 group-hover:h-2'
                  }`}
                />
                <button
                  onClick={() => switchTo(ws.id)}
                  title={tooltip}
                  aria-label={`${name}${isActive ? ' (current workspace)' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  className={`w-10 h-10 rounded-xl flex items-center justify-center font-semibold text-[15px] shrink-0 transition-colors active:scale-95 ${
                    isActive
                      ? 'bg-accent-500 text-white'
                      : 'bg-white/[0.07] text-sidebar-fg hover:bg-white/[0.13]'
                  } ${ws.isDefault && !isActive ? 'ring-1 ring-inset ring-white/15' : ''}`}
                >
                  {ws.isDefault ? <Globe size={18} aria-hidden="true" /> : (ws.name?.[0]?.toUpperCase() || 'W')}
                </button>
              </div>
            );
          })}
        </div>
      ))}

{/* Stage 3 (T.22): only people who may create workspaces see this (the server enforces it). */}
      {canCreateWorkspace && (
      <button
        onClick={() => setShowCreateModal(true)}
        title="Create a workspace"
        aria-label="Create a workspace"
        className="w-10 h-10 rounded-xl border border-dashed border-white/20 text-sidebar-fg-muted hover:border-white/40 hover:text-sidebar-fg flex items-center justify-center transition-colors active:scale-95 mt-1 shrink-0"
      >
        <Plus size={18} aria-hidden="true" />
      </button>
      )}
      <button
        onClick={() => navigate(`/${activeWorkspaceId}/organizations`)}
        title="Organizations"
        aria-label="Organizations"
        aria-current={onOrganizations ? 'page' : undefined}
        className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors active:scale-95 shrink-0 ${
          onOrganizations ? 'bg-accent-500 text-white' : 'bg-white/[0.07] text-sidebar-fg-muted hover:bg-white/[0.13] hover:text-sidebar-fg'
        }`}
      >
        <Building2 size={18} aria-hidden="true" />
      </button>

      <CreateWorkspaceModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
      />
      {dialog}
    </nav>
  );
};
