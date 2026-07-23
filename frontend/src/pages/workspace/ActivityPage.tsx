import { useNavigate } from 'react-router-dom';
import { ActivityView } from '../../components/layout/ActivityView';
import { Channel } from '../../types';
import { useWorkspace } from './WorkspaceContext';

export const ActivityPage = () => {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();

  return (
    <ActivityView
      onSelectChannel={(ch: Channel) => navigate(`/${workspaceId}/c/${ch.id}`)}
      onViewChange={(view: string) => { if (view !== 'chat') navigate(`/${workspaceId}/${view}`); }}
    />
  );
};
