import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useConfirm } from '../../components/ui';
import { errorMessage, workspacesApi } from '../../lib/api';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspaces } from './WorkspacesProvider';

/**
 * Switching to another workspace. A call belongs to the workspace it was
 * started in, so switching mid-call needs an explicit choice (shared by the
 * workspace rail and the organization page).
 */
export const useSwitchWorkspace = () => {
  const { workspaceId: activeWorkspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const { hasActiveCall, endActiveCall } = useWorkspace();
  const { confirm, dialog } = useConfirm();

  const switchTo = useCallback(
    async (targetWorkspaceId: string) => {
      if (targetWorkspaceId === activeWorkspaceId) return;
      if (hasActiveCall) {
        const confirmed = await confirm({
          title: 'End your call?',
          message: 'You have an active call in this workspace. Switching workspaces will end it.',
          confirmLabel: 'End call and switch',
          tone: 'danger',
        });
        if (!confirmed) return;
        endActiveCall();
      }
      navigate(`/${targetWorkspaceId}`);
    },
    [activeWorkspaceId, hasActiveCall, endActiveCall, confirm, navigate]
  );

  return { switchTo, dialog };
};

/**
 * Leaving a workspace (confirmation → POST /leave → drop it from the shared
 * list BEFORE navigating, or "/" would redirect straight back into it).
 * `after` decides where to go next; by default "/" picks the next workspace.
 */
export const useLeaveWorkspace = () => {
  const navigate = useNavigate();
  const { remove } = useWorkspaces();
  const { confirm, dialog } = useConfirm();

  const leave = useCallback(
    async (workspace: { id: string; name: string }, after?: () => void) => {
      const confirmed = await confirm({
        title: `Leave ${workspace.name}?`,
        message: "You'll lose access to its channels and messages, and you'll need a new invitation to come back.",
        confirmLabel: 'Leave workspace',
        tone: 'danger',
      });
      if (!confirmed) return false;
      try {
        await workspacesApi.leaveWorkspace(workspace.id);
        remove(workspace.id);
        // No success toast: the server's workspace:removed ('left') event
        // already produces one (WorkspaceLayout / WorkspaceAdmin).
        if (after) after();
        else navigate('/', { replace: true });
        return true;
      } catch (err) {
        toast.error(errorMessage(err, 'Could not leave the workspace.'));
        return false;
      }
    },
    [confirm, navigate, remove]
  );

  return { leave, dialog };
};
