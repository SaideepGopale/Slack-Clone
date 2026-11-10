import { Navigate } from 'react-router-dom';
import { LoadingState } from '../../components/ui';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { useWorkspaces } from '../workspace/WorkspacesProvider';

/** /:workspaceId/organization — the current workspace's organization page. */
export const OrganizationRedirect = () => {
  const { workspaceId } = useWorkspace();
  const { getWorkspace, loading } = useWorkspaces();
  const organizationId = getWorkspace(workspaceId)?.organization?.id;
  if (loading) return <LoadingState label="Loading organization" />;
  return <Navigate to={organizationId ? `/${workspaceId}/organizations/${organizationId}` : `/${workspaceId}/organizations`} replace />;
};
