import { useNavigate } from 'react-router-dom';
import { DMsView } from '../../components/layout/DMsView';
import { Channel } from '../../types';
import { useWorkspace } from './WorkspaceContext';

export const DMsPage = () => {
  const { workspaceId, channels, onlineUsers } = useWorkspace();
  const navigate = useNavigate();

  return (
    <DMsView
      channels={channels}
      onlineUsers={onlineUsers}
      onSelectChannel={(ch: Channel) => navigate(`/${workspaceId}/c/${ch.id}`)}
      onViewChange={(view: string) => navigate(`/${workspaceId}/${view}`)}
    />
  );
};
