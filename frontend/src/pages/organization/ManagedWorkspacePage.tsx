import { Navigate, useParams } from 'react-router-dom';
import { WorkspaceAdmin } from '../../components/workspaceAdmin/WorkspaceAdmin';
import { useWorkspace } from '../workspace/WorkspaceContext';

/**
 * /:workspaceId/organizations/:organizationId/workspaces/:managedWorkspaceId
 * Administration of another workspace of the organization from the current
 * workspace's layout — the way organization admins manage workspaces they
 * don't belong to. Only management endpoints are used (no channels/messages).
 * Authorization comes from the server, never from the URL's organization id.
 */
export const ManagedWorkspacePage = () => {
  const { workspaceId } = useWorkspace();
  const { managedWorkspaceId = '' } = useParams<{ managedWorkspaceId: string }>();
  if (managedWorkspaceId === workspaceId) return <Navigate to={`/${workspaceId}/settings`} replace />;
  return <WorkspaceAdmin key={managedWorkspaceId} workspaceId={managedWorkspaceId} layoutWorkspaceId={workspaceId} />;
};
