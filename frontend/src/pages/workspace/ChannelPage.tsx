import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ChatArea } from '../../components/chat/ChatArea';
import { useWorkspace } from './WorkspaceContext';

export const ChannelPage = () => {
  const { channelId } = useParams<{ channelId: string }>();
  const { channels, socket, onlineUsers, clearUnread, startCall } = useWorkspace();

  const channel = channels.find(c => c.id === channelId);

  useEffect(() => {
    if (channelId) clearUnread(channelId);
  }, [channelId, clearUnread]);

  if (!channel) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 font-medium bg-white dark:bg-[#111215] transition-colors">
        Select a channel or teammate to start chatting
      </div>
    );
  }

  return (
    <ChatArea
      channel={channel}
      socket={socket!}
      onlineUsers={onlineUsers}
      onStartCall={(type) => startCall(channel.id, type)}
    />
  );
};
