import axios from 'axios';
import { Globe, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { Workspace } from '../../types';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';

// The far-left, always-visible rail — distinct from (and always darker than)
// the channel-list Sidebar next to it, matching the classic Slack "double
// sidebar": this bar switches which tenant you're in, the Sidebar shows that
// tenant's channels. Deliberately outside the mobile-collapsible drawer
// wrapper in WorkspaceLayout.tsx — it's thin enough to stay put on mobile too.
export const WorkspaceSwitcher = () => {
  const { workspaceId: activeWorkspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const { hasActiveCall, endActiveCall } = useWorkspace();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    axios.get<Workspace[]>('/api/workspaces')
      .then(res => setWorkspaces(res.data))
      .catch(err => console.error('Failed to fetch workspaces:', err));
  }, [activeWorkspaceId]);

  const handleCreated = (workspace: Workspace) => {
    setWorkspaces(prev => (prev.some(w => w.id === workspace.id) ? prev : [...prev, workspace]));
  };

  // Pinned to the top regardless of fetch/creation order — computed at
  // render time (not baked into `workspaces` once) so it stays correct after
  // handleCreated appends a freshly created (always private) workspace.
  const sortedWorkspaces = [...workspaces].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

  // A call belongs to the workspace it was started in (CallOverlay enforces
  // this as a hard invariant too — see its workspaceId prop) — switching
  // away mid-call needs an explicit choice, not a silent drop.
  const handleSwitchWorkspace = (targetWorkspaceId: string) => {
    if (targetWorkspaceId === activeWorkspaceId) return;
    if (hasActiveCall) {
      const confirmed = confirm('You have an active call in this workspace. Switching workspaces will end it. Continue?');
      if (!confirmed) return;
      endActiveCall();
    }
    navigate(`/${targetWorkspaceId}`);
  };

  return (
    <div className="w-[68px] h-full bg-violet-950 flex flex-col items-center py-3 gap-2 shrink-0 overflow-y-auto no-scrollbar">
      {sortedWorkspaces.map((ws, index) => {
        const isActive = ws.id === activeWorkspaceId;
        return (
          <div key={ws.id} className="relative w-full flex flex-col items-center">
            <div className="relative w-full flex items-center justify-center group">
              {/* Active-workspace indicator — a white pill flush against the
                  left edge, same convention Slack uses for "you are here". */}
              <div
                className={`absolute left-0 w-1 rounded-r-full bg-white transition-all duration-200 ${
                  isActive ? 'h-8' : 'h-0 group-hover:h-2'
                }`}
              />
              <button
                onClick={() => handleSwitchWorkspace(ws.id)}
                title={ws.isDefault ? `${ws.name} (Default)` : ws.name}
                className={`w-11 h-11 flex items-center justify-center font-black text-lg shrink-0 transition-all duration-200 active:scale-95 ${
                  ws.isDefault
                    ? 'rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-900/40 ring-2 ring-white/20'
                    : isActive
                      ? 'rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-900/40'
                      : 'rounded-3xl bg-white/10 hover:rounded-2xl hover:bg-violet-600/80 text-white'
                }`}
              >
                {ws.isDefault ? <Globe size={20} /> : (ws.name?.[0]?.toUpperCase() || 'W')}
              </button>
            </div>
            {/* Divider between the pinned Default workspace and everyone's
                private workspaces below it — only shown when there's actually
                a private workspace to separate it from. */}
            {ws.isDefault && index === 0 && sortedWorkspaces.length > 1 && (
              <div className="w-8 h-px bg-white/10 my-1.5 shrink-0" />
            )}
          </div>
        );
      })}

      <button
        onClick={() => setShowCreateModal(true)}
        title="Create a workspace"
        className="w-11 h-11 rounded-3xl hover:rounded-2xl bg-white/10 hover:bg-violet-600/80 text-violet-200 hover:text-white flex items-center justify-center transition-all duration-200 active:scale-95 mt-1 shrink-0"
      >
        <Plus size={20} />
      </button>

      <CreateWorkspaceModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
      />
    </div>
  );
};
