import { useNavigate } from 'react-router-dom';
import { ActivityView } from '../../components/layout/ActivityView';
import { requestMessageFocusAfterNavigation } from '../../lib/messageFocus';
import { useWorkspace } from './WorkspaceContext';

export const ActivityPage = () => {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();

  return (
    <ActivityView
      onOpen={(target) => {
        requestMessageFocusAfterNavigation(target);
        navigate(`/${workspaceId}/c/${target.channelId}`);
      }}
    />
  );
};
