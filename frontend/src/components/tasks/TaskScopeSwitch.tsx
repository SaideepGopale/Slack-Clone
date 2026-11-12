import { useNavigate } from 'react-router-dom';
import { useOptionalWorkspaces } from '../../pages/workspace/WorkspacesProvider';

/**
 * T.39 — on phones and tablets, a lead switches between their own tasks and
 * the Team Lead dashboard here (the sidebar does this on desktop, so this is
 * hidden from 1024px up). Shown only to people who manage the workspace; the
 * server enforces the Team Lead endpoints regardless.
 */
export const TaskScopeSwitch = ({ workspaceId, current }: { workspaceId: string; current: 'mine' | 'team' }) => {
  const workspaces = useOptionalWorkspaces();
  const navigate = useNavigate();
  const workspace = workspaces?.getWorkspace(workspaceId);
  if (!workspace || workspace.isDefault || !workspace.capabilities?.canManage) return null;
  const item = (id: 'mine' | 'team', label: string, view: string) => (
    <button
      type="button"
      aria-current={current === id ? 'page' : undefined}
      onClick={() => current !== id && navigate(`/${workspaceId}/${view}`)}
      className={`flex min-h-10 items-center justify-center rounded-lg text-sm font-semibold transition-colors ${current === id ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted active:bg-surface'}`}
    >
      {label}
    </button>
  );
  return (
    <nav aria-label="Task lists" className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-surface-tertiary p-1 lg:hidden">
      {item('mine', 'My tasks', 'tasks')}
      {item('team', 'Team tasks', 'team-tasks')}
    </nav>
  );
};
