import { useNavigate } from 'react-router-dom';
import { HomeView } from '../../components/layout/HomeView';
import { Channel } from '../../types';
import { useWorkspace } from './WorkspaceContext';

export const HomePage = () => {
  const { workspaceId, channels } = useWorkspace();
  const navigate = useNavigate();

  return (
    <HomeView
      channels={channels}
      onSelectChannel={(ch: Channel) => navigate(`/${workspaceId}/c/${ch.id}`)}
      onViewChange={(view: string) => navigate(`/${workspaceId}/${view}`)}
    />
  );
};
