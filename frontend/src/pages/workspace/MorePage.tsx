import { useNavigate } from 'react-router-dom';
import { MoreView } from '../../components/layout/MoreView';
import { useWorkspace } from './WorkspaceContext';

export const MorePage = () => {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();
  return <MoreView onViewChange={(view: string) => navigate(`/${workspaceId}/${view}`)} />;
};
