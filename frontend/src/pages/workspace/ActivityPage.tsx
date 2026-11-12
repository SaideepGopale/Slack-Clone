import { useNavigate, useSearchParams } from 'react-router-dom';
import { ActivityView } from '../../components/layout/ActivityView';
import { WorkActivityView } from '../../components/tasks/WorkActivityView';
import { Tabs } from '../../components/ui/Tabs';
import { requestMessageFocusAfterNavigation } from '../../lib/messageFocus';
import { useWorkspace } from './WorkspaceContext';

/** Activity: chat mentions and replies (Messages) and, T.33, task activity (Tasks). */
export const ActivityPage = () => {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'tasks' ? 'tasks' : 'messages';

  return (
    <div className="flex h-full flex-1 flex-col bg-surface">
      <Tabs
        label="Activity type"
        idPrefix="activity"
        tabs={[
          { id: 'messages', label: 'Messages' },
          { id: 'tasks', label: 'Tasks' },
        ]}
        value={tab}
        onChange={(id) => setParams(id === 'tasks' ? { tab: 'tasks' } : {}, { replace: true })}
        className="shrink-0 border-b border-line px-4 pt-2"
      />
      {tab === 'tasks' ? (
        <WorkActivityView />
      ) : (
        <ActivityView
          onOpen={(target) => {
            requestMessageFocusAfterNavigation(target);
            navigate(`/${workspaceId}/c/${target.channelId}`);
          }}
        />
      )}
    </div>
  );
};
