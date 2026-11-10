import { WorkspaceAdmin } from '../../../components/workspaceAdmin/WorkspaceAdmin';
import { useWorkspace } from '../WorkspaceContext';

/** /:workspaceId/settings — settings, members, invitations and join requests of the current workspace. */
export const WorkspaceSettingsPage = () => {
  const { workspaceId } = useWorkspace();
  return <WorkspaceAdmin key={workspaceId} workspaceId={workspaceId} layoutWorkspaceId={workspaceId} />;
};
