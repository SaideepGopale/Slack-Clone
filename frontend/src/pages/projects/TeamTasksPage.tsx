import { AlertTriangle, CheckCircle2, CircleDashed, ListChecks, Plus, Search, Timer, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreateTeamTaskModal } from '../../components/tasks/team/CreateTeamTaskModal';
import { AssigneeAvatar, DueChip, formatDay, PriorityIcon, selectClass, StatusBadge } from '../../components/tasks/TaskBits';
import { TaskDrawer } from '../../components/tasks/TaskDrawer';
import { TaskScopeSwitch } from '../../components/tasks/TaskScopeSwitch';
import { Button, EmptyState, ErrorState } from '../../components/ui';
import { useTaskEvents } from '../../hooks/useTaskEvents';
import { errorMessage, toApiError } from '../../lib/api/http';
import type { ProjectMember } from '../../lib/api/projects';
import {
  getTeamSummary,
  getTeamTaskOptions,
  listTeamTasks,
  personName,
  PRIORITY_LABELS,
  TASK_PRIORITIES,
  TaskView,
  TeamDueFilter,
  TeamStatusFilter,
  TeamSummary,
  TeamTaskFilters,
  TeamTaskOptions,
} from '../../lib/api/tasks';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { useWorkspaces } from '../workspace/WorkspacesProvider';

/**
 * T.38 — the Team Lead dashboard: totals, each member's progress, every task
 * of the workspace with filters, and fast assignment. Lead-only on the
 * server (403 for members, 404 outside the workspace); this page only renders
 * what the API returns. Live: task events refresh it (the server sends a
 * private assignment's events to its assignee and the leads only).
 */
const PAGE = 50;

type CardId = 'all' | 'todo' | 'in_progress' | 'completed' | 'overdue';

export const TeamTasksPage = () => {
  const { workspaceId, socket } = useWorkspace();
  const workspace = useWorkspaces().getWorkspace(workspaceId);
  const [summary, setSummary] = useState<TeamSummary | null>(null);
  const [options, setOptions] = useState<TeamTaskOptions | null>(null);
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState<TeamTaskFilters>({});
  const [search, setSearch] = useState('');
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const listRequest = useRef(0);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await getTeamSummary(workspaceId));
    } catch (err) {
      const status = toApiError(err).status;
      if (status === 403 || status === 404) setDenied(errorMessage(err, 'Team tasks are for this workspace’s Team Lead.'));
      else setError(errorMessage(err, 'The team overview could not be loaded.'));
    }
  }, [workspaceId]);

  const loadTasks = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const page = await listTeamTasks(workspaceId, { ...filters, limit: PAGE });
      if (request !== listRequest.current) return;
      setTasks(page.tasks);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (request !== listRequest.current) return;
      const status = toApiError(err).status;
      if (status === 403 || status === 404) setDenied(errorMessage(err, 'Team tasks are for this workspace’s Team Lead.'));
      else setError(errorMessage(err, 'Tasks could not be loaded.'));
    }
  }, [workspaceId, filters]);

  useEffect(() => {
    setDenied(null);
    void loadSummary();
    getTeamTaskOptions(workspaceId).then(setOptions, () => undefined);
  }, [workspaceId, loadSummary]);

  useEffect(() => {
    setTasks(null);
    void loadTasks();
  }, [loadTasks]);

  // Search as you type (debounced).
  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.q === (search.trim() || undefined) ? f : { ...f, q: search.trim() || undefined })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Live: any task change in this workspace may move numbers and rows.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void loadSummary();
      void loadTasks();
    }, 250);
  }, [loadSummary, loadTasks]);
  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);
  useTaskEvents(socket, {
    onUpsert: (task) => {
      if (task.workspaceId === workspaceId) refresh();
    },
    onDelete: refresh,
  });

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listTeamTasks(workspaceId, { ...filters, limit: PAGE, cursor: nextCursor });
      setTasks((list) => [...(list ?? []), ...page.tasks.filter((t) => !list?.some((x) => x.id === t.id))]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err, 'More tasks could not be loaded.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const activeCard: CardId | null = filters.overdue
    ? 'overdue'
    : filters.status === 'todo' || filters.status === 'in_progress' || filters.status === 'completed'
      ? filters.status
      : !filters.status && !filters.due
        ? 'all'
        : null;
  const pickCard = (id: CardId) =>
    setFilters((f) => ({ ...f, status: id === 'all' || id === 'overdue' ? undefined : id, overdue: id === 'overdue' || undefined, due: undefined }));
  const filtersActive = !!(filters.assigneeId || filters.status || filters.priority || filters.due || filters.overdue || filters.q);
  const clearFilters = () => {
    setSearch('');
    setFilters({});
  };

  const drawerMembers: ProjectMember[] = useMemo(
    () => (options?.members ?? []).map((m) => ({ userId: m.id, role: 'MEMBER' as const, joinedAt: '', user: { id: m.id, username: personName(m) } })),
    [options]
  );

  if (denied) {
    return (
      <div className="h-full overflow-y-auto bg-surface-secondary">
        <div className="mx-auto max-w-3xl p-4 sm:p-8">
          <EmptyState icon={<Users size={24} />} title="Team tasks are for Team Leads" description={`${denied} Your own tasks are under My Tasks.`} />
        </div>
      </div>
    );
  }

  const cards: { id: CardId; label: string; value: number | undefined; icon: typeof ListChecks; tone: string }[] = [
    { id: 'all', label: 'Total tasks', value: summary?.totals.total, icon: ListChecks, tone: 'text-brand bg-brand-soft' },
    { id: 'todo', label: 'To do', value: summary?.totals.todo, icon: CircleDashed, tone: 'text-fg-muted bg-surface-tertiary' },
    { id: 'in_progress', label: 'In progress', value: summary?.totals.inProgress, icon: Timer, tone: 'text-warning bg-warning-soft' },
    { id: 'completed', label: 'Completed', value: summary?.totals.completed, icon: CheckCircle2, tone: 'text-success bg-success-soft' },
    { id: 'overdue', label: 'Overdue', value: summary?.totals.overdue, icon: AlertTriangle, tone: 'text-danger bg-danger-soft' },
  ];

  return (
    <div className="h-full overflow-y-auto bg-surface-secondary">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
        <TaskScopeSwitch workspaceId={workspaceId} current="team" />
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-fg">Team tasks</h1>
            <p className="mt-1 text-sm text-fg-muted">Assign work and follow each member’s progress{workspace ? ` in ${workspace.name}` : ''}. Members see only their own tasks.</p>
          </div>
          <Button icon={<Plus size={16} aria-hidden="true" />} onClick={() => setCreating(true)} disabled={!options} className="shrink-0 whitespace-nowrap">
            Create task
          </Button>
        </header>

        {/* Summary cards — each one filters the table. */}
        <section aria-label="Task summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {cards.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickCard(c.id)}
              aria-pressed={activeCard === c.id}
              aria-label={`${c.label}: ${c.value ?? 'loading'}`}
              className={`flex items-center gap-3 rounded-xl border bg-surface p-3 text-left transition-colors hover:border-brand/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${activeCard === c.id ? 'border-brand ring-1 ring-brand' : 'border-line'}`}
            >
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${c.tone}`} aria-hidden="true">
                <c.icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-fg-muted">{c.label}</span>
                <span className="block text-xl font-bold tabular-nums text-fg">{c.value ?? <span className="skeleton inline-block h-5 w-8 rounded" />}</span>
              </span>
            </button>
          ))}
        </section>

        {/* Member-wise progress — each row filters the table. */}
        <section aria-labelledby="team-progress-heading" className="rounded-xl border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 id="team-progress-heading" className="text-sm font-semibold text-fg">
              Member progress
            </h2>
            {filters.assigneeId && (
              <button type="button" onClick={() => setFilters((f) => ({ ...f, assigneeId: undefined }))} className="text-xs font-semibold text-brand hover:underline">
                Show everyone
              </button>
            )}
          </div>
          {!summary ? (
            <ul className="space-y-2 p-4" role="status" aria-label="Loading member progress">
              {[0, 1, 2].map((i) => (
                <li key={i} className="skeleton h-12 rounded-lg" aria-hidden="true" />
              ))}
            </ul>
          ) : summary.members.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-muted">No active members yet. Add people from the People page.</p>
          ) : (
            <ul className="divide-y divide-line" aria-label="Members">
              {summary.members.map((m) => {
                const selected = filters.assigneeId === m.user.id;
                const name = personName(m.user);
                return (
                  <li key={m.user.id}>
                    <button
                      type="button"
                      onClick={() => setFilters((f) => ({ ...f, assigneeId: selected ? undefined : m.user.id }))}
                      aria-pressed={selected}
                      aria-label={`${name}: ${m.completed} of ${m.total} completed (${m.completionRate}%), ${m.inProgress} in progress, ${m.pending} to do, ${m.overdue} overdue`}
                      className={`grid w-full grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-surface-secondary focus:outline-none focus-visible:bg-surface-secondary sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.2fr)_auto] ${selected ? 'bg-brand-soft/60' : ''}`}
                    >
                      <AssigneeAvatar user={m.user} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-fg">{name}</span>
                        <span className="block text-xs text-fg-subtle">
                          {m.completed}/{m.total} completed
                        </span>
                      </span>
                      <span className="col-span-2 flex items-center gap-2 sm:col-span-1">
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-tertiary" role="progressbar" aria-label={`${name} completion`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.completionRate}>
                          <span className="block h-full rounded-full bg-success transition-[width] duration-500" style={{ width: `${m.completionRate}%` }} />
                        </span>
                        <span className="w-10 text-right text-xs font-semibold tabular-nums text-fg">{m.completionRate}%</span>
                      </span>
                      <span className="col-span-2 flex flex-wrap gap-1.5 text-[11px] font-medium sm:col-span-1 sm:justify-end">
                        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">{m.inProgress} in progress</span>
                        <span className="rounded-full bg-surface-tertiary px-2 py-0.5 text-fg-muted">{m.pending} to do</span>
                        {m.overdue > 0 && <span className="rounded-full bg-danger-soft px-2 py-0.5 text-danger">{m.overdue} overdue</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* All tasks */}
        <section aria-labelledby="team-tasks-heading" className="rounded-xl border border-line bg-surface">
          <div className="flex flex-col gap-3 border-b border-line px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 id="team-tasks-heading" className="text-sm font-semibold text-fg">
                Tasks {tasks && <span className="font-normal text-fg-subtle">· {total}</span>}
              </h2>
              {filtersActive && (
                <button type="button" onClick={clearFilters} className="text-xs font-semibold text-brand hover:underline">
                  Clear filters
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 lg:items-center xl:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))_auto]">
              <label className="relative col-span-2 lg:col-span-3 xl:col-span-1">
                <span className="sr-only">Search tasks</span>
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" className={`${selectClass} pl-8`} />
              </label>
              <select aria-label="Member" className={selectClass} value={filters.assigneeId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, assigneeId: e.target.value || undefined }))}>
                <option value="">All members</option>
                <option value="none">Unassigned</option>
                {(options?.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {personName(m)}
                  </option>
                ))}
              </select>
              <select aria-label="Status" className={selectClass} value={filters.status ?? ''} onChange={(e) => setFilters((f) => ({ ...f, status: (e.target.value || undefined) as TeamStatusFilter | undefined }))}>
                <option value="">Any status</option>
                <option value="todo">To do</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <select aria-label="Priority" className={selectClass} value={filters.priority ?? ''} onChange={(e) => setFilters((f) => ({ ...f, priority: (e.target.value || undefined) as TeamTaskFilters['priority'] }))}>
                <option value="">Any priority</option>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
              <select aria-label="Due date" className={selectClass} value={filters.due ?? ''} onChange={(e) => setFilters((f) => ({ ...f, due: (e.target.value || undefined) as TeamDueFilter | undefined }))}>
                <option value="">Any date</option>
                <option value="overdue">Overdue</option>
                <option value="today">Due today</option>
                <option value="week">Due in 7 days</option>
                <option value="none">No due date</option>
              </select>
              <label className="flex items-center gap-2 whitespace-nowrap text-xs font-medium text-fg-muted">
                <input type="checkbox" checked={!!filters.overdue} onChange={(e) => setFilters((f) => ({ ...f, overdue: e.target.checked || undefined }))} className="h-4 w-4 accent-[var(--color-brand)]" />
                Overdue only
              </label>
            </div>
          </div>

          {error ? (
            <ErrorState message={error} onRetry={() => void loadTasks()} />
          ) : tasks === null ? (
            <ul className="space-y-2 p-4" role="status" aria-label="Loading tasks">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="skeleton h-11 rounded-lg" aria-hidden="true" />
              ))}
            </ul>
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={<ListChecks size={24} />}
              title={filtersActive ? 'No tasks match these filters' : 'No tasks yet'}
              description={filtersActive ? 'Try clearing a filter.' : 'Create a task and assign it to a member — they see it in My Tasks right away.'}
              action={!filtersActive ? <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setCreating(true)} disabled={!options}>Create task</Button> : undefined}
            />
          ) : (
            <>
              {/* Table (desktop, 1024px and up) */}
              <div className="hidden lg:block">
                <table className="w-full table-fixed text-sm" aria-label="Team tasks">
                  <thead>
                    <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                      <th scope="col" className="w-[31%] px-4 py-2">Task</th>
                      <th scope="col" className="w-[16%] px-2 py-2">Assigned to</th>
                      <th scope="col" className="w-[10%] px-2 py-2">Priority</th>
                      <th scope="col" className="w-[11%] px-2 py-2">Due</th>
                      <th scope="col" className="w-[12%] px-2 py-2">Status</th>
                      <th scope="col" className="w-[9%] px-2 py-2">Created</th>
                      <th scope="col" className="w-[11%] px-4 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {tasks.map((t) => (
                      <tr key={t.id} className="hover:bg-surface-secondary">
                        <td className="px-4 py-2.5">
                          <span className="block truncate font-medium text-fg" title={t.title}>
                            {t.title}
                          </span>
                          <span className="font-mono text-[11px] text-fg-subtle">{t.identifier}</span>
                        </td>
                        <td className="px-2 py-2.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <AssigneeAvatar user={t.assignee} />
                            <span className="truncate text-fg">{personName(t.assignee)}</span>
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          <PriorityIcon priority={t.priority} withLabel />
                        </td>
                        <td className="px-2 py-2.5">{t.dueDate ? <DueChip task={t} /> : <span className="text-xs text-fg-subtle">—</span>}</td>
                        <td className="px-2 py-2.5">
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="px-2 py-2.5 text-xs text-fg-muted">{formatDay(t.createdAt)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <Button size="sm" variant="secondary" onClick={() => setOpenTaskId(t.id)} aria-label={`Open ${t.identifier}: ${t.title}`}>
                            Open
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Cards (phones and tablets) */}
              <ul className="divide-y divide-line lg:hidden" aria-label="Team tasks">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => setOpenTaskId(t.id)} className="flex w-full flex-col gap-1.5 px-4 py-3 text-left hover:bg-surface-secondary">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-fg-subtle">{t.identifier}</span>
                        <span className="truncate text-sm font-medium text-fg">{t.title}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                        <StatusBadge status={t.status} />
                        <PriorityIcon priority={t.priority} />
                        <DueChip task={t} />
                        <span className="inline-flex items-center gap-1">
                          <AssigneeAvatar user={t.assignee} />
                          {personName(t.assignee)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {nextCursor && (
                <div className="flex justify-center border-t border-line p-3">
                  <Button variant="secondary" size="sm" onClick={() => void loadMore()} loading={loadingMore}>
                    Load more ({tasks.length} of {total})
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {creating && options && (
        <CreateTeamTaskModal
          workspaceId={workspaceId}
          options={options}
          initialAssigneeId={filters.assigneeId && filters.assigneeId !== 'none' ? filters.assigneeId : undefined}
          onCreated={() => refresh()}
          onClose={() => setCreating(false)}
        />
      )}
      {openTaskId && (
        <TaskDrawer
          taskId={openTaskId}
          projectTasks={[]}
          members={drawerMembers}
          canCreateTask={false}
          onClose={() => setOpenTaskId(null)}
          onChanged={() => refresh()}
          onDeleted={() => {
            setOpenTaskId(null);
            refresh();
          }}
          onOpenTask={setOpenTaskId}
        />
      )}
    </div>
  );
};

export default TeamTasksPage;
