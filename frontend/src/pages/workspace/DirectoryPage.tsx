import { useWorkspace } from './WorkspaceContext';
import { Directory } from '../../components/layout/Directory';

export const DirectoryPage = () => {
  const { fetchChannels, onlineUsers, startDM } = useWorkspace();

  return (
    <Directory
      onChannelJoined={fetchChannels}
      onlineUsers={onlineUsers}
      onSelectUser={startDM}
    />
  );
};
