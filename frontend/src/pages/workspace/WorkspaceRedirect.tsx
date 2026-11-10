import { Navigate } from 'react-router-dom';
import { CreateWorkspaceModal } from '../../components/sidebar/CreateWorkspaceModal';
import { ErrorState } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { pickLandingWorkspace } from '../../lib/workspaceLanding';
import { LoadingScreen } from './WorkspaceLayout';
import { useWorkspaces } from './WorkspacesProvider';

// Landing route for "/" — sends a signed-in user to their last-active
// workspace (User.lastActiveWorkspaceId, kept in sync by WorkspaceLayout), or
// failing that, to one of their own/shared workspaces before SmartConnect
// Collab (lib/workspaceLanding.ts). Reads the shared workspace
// list (WorkspacesProvider) instead of fetching its own copy (F1).
//
// If they genuinely have no workspaces at all (e.g. the default workspace
// hasn't been seeded), this shows a create prompt instead of an empty layout.
export const WorkspaceRedirect = () => {
  const { user } = useAuth();
  const { workspaces, loading, error, refresh } = useWorkspaces();

  if (loading) return <LoadingScreen />;
  if (error && workspaces.length === 0) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface-secondary p-6">
        <ErrorState title="Couldn't load your workspaces" message={error} onRetry={() => refresh().catch(() => undefined)} />
      </div>
    );
  }

  const target = pickLandingWorkspace(workspaces, user?.lastActiveWorkspaceId);
  if (target) return <Navigate to={`/${target}`} replace />;

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-gray-50 gap-4 p-6 text-center">
      <h1 className="text-2xl font-black text-gray-900 tracking-tight">You're not in a workspace yet</h1>
      <p className="text-gray-500 max-w-sm">Create one to get started — you'll be its admin, with a "General" channel ready to go.</p>
      <CreateWorkspaceModal isOpen onClose={() => {}} onCreated={() => refresh().catch(() => undefined)} />
    </div>
  );
};
