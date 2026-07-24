import axios from 'axios';
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { CreateWorkspaceModal } from '../../components/sidebar/CreateWorkspaceModal';
import { useAuth } from '../../contexts/AuthContext';
import { Workspace } from '../../types';
import { LoadingScreen } from './WorkspaceLayout';

// "/" has no workspace of its own — every post-login/post-invite/catch-all
// redirect lands here, and this resolves it into a real `/:workspaceId`.
// Every user is auto-joined to a workspace on signup (self-serve signup and
// invitation acceptance both guarantee this backend-side), so the "zero
// workspaces" branch below is a defensive fallback, not the expected path.
export const WorkspaceRedirect = () => {
  const { user } = useAuth();
  const [workspaceId, setWorkspaceId] = useState<string | null>();

  useEffect(() => {
    axios.get<Workspace[]>('/api/workspaces')
      .then(res => {
        // Prefer wherever the user was last active, but only if it's still
        // actually in their list (they could have lost access, or it could
        // have been deleted) — otherwise fall back to the first workspace,
        // same as before this field existed.
        const lastActive = user?.lastActiveWorkspaceId
          ? res.data.find(w => w.id === user.lastActiveWorkspaceId)
          : undefined;
        setWorkspaceId(lastActive?.id ?? res.data[0]?.id ?? null);
      })
      .catch(() => setWorkspaceId(null));
  }, [user?.lastActiveWorkspaceId]);

  if (workspaceId === undefined) return <LoadingScreen />;
  if (workspaceId) return <Navigate to={`/${workspaceId}`} replace />;

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-gray-50 gap-4 p-6 text-center">
      <h1 className="text-2xl font-black text-gray-900 tracking-tight">You're not in a workspace yet</h1>
      <p className="text-gray-500 max-w-sm">Create one to get started — you'll be its admin, with a "General" channel ready to go.</p>
      <CreateWorkspaceModal isOpen onClose={() => {}} />
    </div>
  );
};
