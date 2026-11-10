import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ChatArea } from '../../components/chat/ChatArea';
import { findConversation, useWorkspace } from './WorkspaceContext';

export const ChannelPage = () => {
  const { channelId } = useParams<{ channelId: string }>();
  const { channels, dms, channelsLoading, dmsLoading, socket, onlineUsers, clearUnread, startCall } = useWorkspace();

  // DMs live in their own list (the backend excludes them from `channels`);
  // previously only `channels` was searched, so every DM rendered the
  // "Select a channel" placeholder (audit BUG-01).
  const channel = findConversation(channels, dms, channelId);

  useEffect(() => {
    if (channelId) clearUnread(channelId);
  }, [channelId, clearUnread]);

  if (!channel) {
    if (channelsLoading || dmsLoading) {
      return (
        <div className="flex-1 flex items-center justify-center bg-white" role="status" aria-label="Loading conversation">
          <Loader2 className="animate-spin text-violet-500" size={24} />
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 font-medium bg-white text-center px-6">
        This conversation doesn't exist or you don't have access to it.
      </div>
    );
  }

  return (
    // Keyed by conversation: switching remounts the chat, so drafts,
    // staged attachments and scroll state never leak between conversations.
    <ChatArea
      key={channel.id}
      channel={channel}
      socket={socket!}
      onlineUsers={onlineUsers}
      onStartCall={(type) => startCall(channel.id, type)}
    />
  );
};
