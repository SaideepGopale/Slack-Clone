import { format, parseISO } from 'date-fns';
import { CheckCircle2, ListChecks, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { AssigneeAvatar, DueChip, PriorityIcon, StatusBadge } from '../../components/tasks/TaskBits';
import { TaskDrawer } from '../../components/tasks/TaskDrawer';
import { TaskScopeSwitch } from '../../components/tasks/TaskScopeSwitch';
import { Button, EmptyState, ErrorState, Tabs, useConfirm } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useTaskEvents } from '../../hooks/useTaskEvents';
import { errorMessage } from '../../lib/api/http';
import { listMyTasks, MyTasksCounts, MyTasksView, personName, TaskStatus, TaskView, updateTask } from '../../lib/api/tasks';
import { useWorkspace } from '../workspace/WorkspaceContext';

/**
 * T.33 — My Tasks: what is on my plate across every project of the workspace.
 * T.38 — the member's task dashboard: their own tasks by stage (To do, In
 * progress, Completed, Overdue), each card with who assigned it; Start and
 * Mark complete right on the card (completion asks first), details in a
 * drawer here. The server only ever returns the caller's own tasks (and, for
 * leads, tasks they assigned under "Assigned by me").
 */
const VIEWS: { id: MyTasksView; label: string; count: keyof MyTasksCounts; empty: string }[] = [
  { id: 'assigned', label: 'My tasks', count: 'assigned', empty: 'Nothing is assigned to you right now.' },
  { id: 'todo', label: 'To do', count: 'todo', empty: 'No tasks waiting to be started.' },
  { id: 'in-progress', label: 'In progress', count: 'inProgress', empty: 'Nothing in progress right now.' },
  { id: 'completed', label: 'Completed', count: 'completed', empty: 'Tasks you complete show up here.' },
  { id: 'overdue', label: 'Overdue', count: 'overdue', empty: 'Nothing overdue — nice.' },
  { id: 'due-soon', label: 'Due soon', count: 'dueSoon', empty: 'Nothing due in the next 7 days.' },
  { id: 'created', label: 'Assigned by me', count: 'created', empty: "You haven't assigned any open tasks." },
];

const TODO: TaskStatus[] = ['BACKLOG', 'TODO', 'BLOCKED'];
const IN_PROGRESS: TaskStatus[] = ['IN_PROGRESS', 'IN_REVIEW'];

export const MyTasksPage = () => {
  const { workspaceId, socket } = useWorkspace();
  const { user } = useAuth();
  const { confirm, dialog } = useConfirm();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some((v) => v.id === params.get('view')) ? params.get('view') : 'assigned') as MyTasksView;
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [counts, setCounts] = useState<MyTasksCounts | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setError(null);
    try {
      const page = await listMyTasks(workspaceId, view, { limit: 50 });
      if (request !== requestRef.current) return;
      setTasks(page.tasks);
      setCounts(page.counts);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (request === requestRef.current) setError(errorMessage(err, 'Your tasks could not be loaded.'));
    }
  }, [workspaceId, view]);

  useEffect(() => {
    setTasks(null);
    void load();
  }, [load]);

  // Any change to one of my tasks may move it between views.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void load(), 300);
  }, [load]);
  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);
  useTaskEvents(socket, { onUpsert: scheduleRefresh, onDelete: scheduleRefresh });

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listMyTasks(workspaceId, view, { limit: 50, cursor: nextCursor });
      setTasks((list) => [...(list ?? []), ...page.tasks.filter((t) => !list?.some((x) => x.id === t.id))]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err, 'More tasks could not be loaded.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const setStatus = async (task: TaskView, status: TaskStatus) => {
    setBusyId(task.id);
    try {
      const { task: updated } = await updateTask(task.id, { status });
      setTasks((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
      toast.success(status === 'DONE' ? `“${task.title}” is completed.` : `“${task.title}” is in progress.`);
      scheduleRefresh();
    } catch (err) {
      toast.error(errorMessage(err, 'The task could not be updated.'));
    } finally {
      setBusyId(null);
    }
  };

  const complete = async (task: TaskView) => {
    const ok = await confirm({
      title: 'Mark this task as completed?',
      message: `“${task.title}” will be marked completed and your Team Lead will see it right away.`,
      confirmLabel: 'Mark completed',
    });
    if (ok) await setStatus(task, 'DONE');
  };

  // A project task opens on its board (T.33); a private assignment — whose
  // project its assignee may not open — shows its details right here (T.38).
  const open = (task: TaskView) => (task.assigneeOnly ? setOpenTaskId(task.id) : navigate(`/${workspaceId}/projects/${task.projectId}?task=${task.id}`));

  const current = VIEWS.find((v) => v.id === view)!;
  // "Assigned by me" is for people who assign work; shown once there is any.
  const visibleViews = VIEWS.filter((v) => v.id !== 'created' || view === 'created' || (counts?.created ?? 0) > 0);

  return (
    <div className="h-full overflow-y-auto bg-surface-secondary">
      {dialog}
      <div className="mx-auto max-w-5xl p-4 sm:p-8">
        <TaskScopeSwitch workspaceId={workspaceId} current="mine" />
        <header className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-fg">My tasks</h1>
          <p className="mt-1 text-sm text-fg-muted">The work assigned to you in this workspace.</p>
        </header>
        <div className="overflow-x-auto">
          <Tabs
            label="Task views"
            idPrefix="my-tasks"
            value={view}
            onChange={(id) => setParams(id === 'assigned' ? {} : { view: id }, { replace: true })}
            tabs={visibleViews.map((v) => ({ id: v.id, label: v.label, count: counts?.[v.count] }))}
            className="min-w-max"
          />
        </div>
        <div role="tabpanel" id={`my-tasks-panel-${view}`} aria-labelledby={`my-tasks-tab-${view}`} className="mt-4">
          {error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : tasks === null ? (
            <ul className="space-y-2" role="status" aria-label="Loading tasks">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="skeleton h-20 rounded-xl" aria-hidden="true" />
              ))}
            </ul>
          ) : tasks.length === 0 ? (
            <EmptyState icon={view === 'completed' ? <CheckCircle2 size={24} /> : <ListChecks size={24} />} title={current.empty} />
          ) : (
            <>
              <ul className="space-y-2" aria-label={current.label}>
                {tasks.map((t) => {
                  const mine = !!user && t.assignee?.id === user.id;
                  const busy = busyId === t.id;
                  return (
                    <li key={t.id} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-start">
                      <button
                        type="button"
                        onClick={() => open(t)}
                        aria-label={`Open ${t.identifier}: ${t.title}`}
                        className="min-w-0 flex-1 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[11px] font-semibold text-fg-subtle">{t.identifier}</span>
                          <span className={`truncate text-sm font-semibold ${t.status === 'DONE' ? 'text-fg-muted line-through decoration-fg-subtle/50' : 'text-fg'}`}>{t.title}</span>
                        </span>
                        {t.description && <span className="mt-1 line-clamp-2 block text-sm text-fg-muted">{t.description}</span>}
                        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted">
                          <StatusBadge status={t.status} />
                          <PriorityIcon priority={t.priority} withLabel />
                          <DueChip task={t} />
                          {view === 'created' ? (
                            <span className="inline-flex items-center gap-1">
                              <AssigneeAvatar user={t.assignee} />
                              Assigned to {personName(t.assignee)}
                            </span>
                          ) : (
                            t.creator && t.creator.id !== user?.id && <span>Assigned by {personName(t.creator)}</span>
                          )}
                          {t.project && !t.assigneeOnly && <span className="max-w-[12rem] truncate text-fg-subtle">{t.project.name}</span>}
                          {t.status === 'DONE' && t.completedAt && (
                            <span className="inline-flex items-center gap-1 font-medium text-success">
                              <CheckCircle2 size={12} aria-hidden="true" /> Completed {format(parseISO(t.completedAt), 'MMM d, h:mm a')}
                            </span>
                          )}
                        </span>
                      </button>
                      {mine && TODO.includes(t.status) && (
                        <Button size="sm" variant="secondary" loading={busy} onClick={() => void setStatus(t, 'IN_PROGRESS')} icon={<Play size={13} aria-hidden="true" />} aria-label={`Start ${t.title}`}>
                          Start
                        </Button>
                      )}
                      {mine && IN_PROGRESS.includes(t.status) && (
                        <Button size="sm" loading={busy} onClick={() => void complete(t)} icon={<CheckCircle2 size={14} aria-hidden="true" />} aria-label={`Mark ${t.title} as completed`}>
                          Mark complete
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {nextCursor && (
                <div className="mt-4 flex justify-center">
                  <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {openTaskId && (
        <TaskDrawer
          taskId={openTaskId}
          projectTasks={[]}
          members={[]}
          canCreateTask={false}
          onClose={() => setOpenTaskId(null)}
          onChanged={() => scheduleRefresh()}
          onDeleted={() => {
            setOpenTaskId(null);
            scheduleRefresh();
          }}
          onOpenTask={setOpenTaskId}
        />
      )}
    </div>
  );
};
