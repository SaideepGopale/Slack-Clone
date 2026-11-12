import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NewConversationModal } from '../../components/conversations/NewConversationModal';
import { DMsView } from '../../components/layout/DMsView';
import { useAuth } from '../../contexts/AuthContext';
import { Channel } from '../../types';
import { useWorkspace } from './WorkspaceContext';

export const DMsPage = () => {
  const { workspaceId, dms, dmsLoading, onlineUsers, unreadCounts, startDM, upsertDM } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [composing, setComposing] = useState(false);

  return (
    <>
      <DMsView
        dms={dms}
        loading={dmsLoading}
        onlineUsers={onlineUsers}
        unreadCounts={unreadCounts}
        currentUserId={user?.id}
        onSelectChannel={(ch: Channel) => navigate(`/${workspaceId}/c/${ch.id}`)}
        onNewConversation={() => setComposing(true)}
      />
      {composing && user && (
        <NewConversationModal
          workspaceId={workspaceId}
          currentUserId={user.id}
          onClose={() => setComposing(false)}
          onStartDM={startDM}
          onGroupCreated={(conversation) => {
            upsertDM({ ...conversation, isDM: true, lastActivityAt: conversation.lastActivityAt ?? new Date().toISOString() });
            navigate(`/${workspaceId}/c/${conversation.id}`);
          }}
        />
      )}
    </>
  );
};
