import { addMonths, format } from 'date-fns';
import { ArrowDownUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../lib/api/http';
import {
  getProjectReport,
  getWorkload,
  PRIORITY_LABELS,
  ProjectReport,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskView,
  WorkloadPerson,
  personName,
} from '../../lib/api/tasks';
import { dateOnly, monthGrid, SortKey, sortTasks, todayKey } from '../../lib/tasks/board';
import { Avatar } from '../ui/Avatar';
import { EmptyState, ErrorState, LoadingState } from '../ui';
import { AssigneeAvatar, DueChip, formatDay, PriorityIcon, STATUS_DOT, StatusBadge } from './TaskBits';

/** T.33 — the non-board project views: list, calendar, workload, overview. */

// ---- List ---------------------------------------------------------------------

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'identifier', label: 'ID', className: 'w-24' },
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status', className: 'w-32' },
  { key: 'priority', label: 'Priority', className: 'w-28' },
  { key: 'assignee', label: 'Assignee', className: 'w-40' },
  { key: 'dueDate', label: 'Due', className: 'w-28' },
];

export const TaskListView = ({ tasks, onOpen }: { tasks: TaskView[]; onOpen: (id: string) => void }) => {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'status', dir: 'asc' });
  const sorted = useMemo(() => sortTasks(tasks, sort.key, sort.dir), [tasks, sort]);
  if (tasks.length === 0) return <EmptyState title="No tasks match" description="Change the filters or add a task." />;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead className="bg-surface-secondary text-left text-xs font-semibold text-fg-muted">
          <tr>
            {COLUMNS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th key={c.key} scope="col" className={`px-3 py-2 ${c.className ?? ''}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button
                    type="button"
                    onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === 'asc' ? 'desc' : 'asc' }))}
                    className="inline-flex items-center gap-1 rounded hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {c.label}
                    <ArrowDownUp size={12} className={active ? 'text-brand' : 'text-fg-subtle'} aria-hidden="true" />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => (
            <tr key={t.id} className="border-t border-line hover:bg-surface-secondary">
              <td className="px-3 py-2 font-mono text-xs text-fg-subtle">{t.identifier}</td>
              <td className="px-3 py-2">
                <button type="button" onClick={() => onOpen(t.id)} className="text-left font-medium text-fg hover:text-brand hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                  {t.title}
                </button>
                {t.subtaskCount > 0 && <span className="ml-2 text-xs text-fg-subtle">{t.subtasksDone}/{t.subtaskCount} subtasks</span>}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={t.status} />
              </td>
              <td className="px-3 py-2">
                <PriorityIcon priority={t.priority} withLabel />
              </td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-2">
                  <AssigneeAvatar user={t.assignee} />
                  <span className="truncate text-fg-muted">{personName(t.assignee)}</span>
                </span>
              </td>
              <td className="px-3 py-2">
                <DueChip task={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ---- Calendar -----------------------------------------------------------------

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const TaskCalendarView = ({ tasks, onOpen }: { tasks: TaskView[]; onOpen: (id: string) => void }) => {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const weeks = useMemo(() => monthGrid(month.getFullYear(), month.getMonth()), [month]);
  const byDay = useMemo(() => {
    const map = new Map<string, TaskView[]>();
    for (const t of tasks) {
      const day = dateOnly(t.dueDate);
      if (!day) continue;
      map.set(day, [...(map.get(day) ?? []), t]);
    }
    return map;
  }, [tasks]);
  const monthPrefix = format(month, 'yyyy-MM');
  const today = todayKey();
  const undated = tasks.filter((t) => !t.dueDate).length;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button type="button" aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))} className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-tertiary hover:text-fg">
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <h3 className="min-w-[9rem] text-center text-sm font-semibold text-fg" aria-live="polite">
          {format(month, 'MMMM yyyy')}
        </h3>
        <button type="button" aria-label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))} className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-tertiary hover:text-fg">
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setMonth(() => {
            const now = new Date();
            return new Date(now.getFullYear(), now.getMonth(), 1);
          })}
          className="ml-1 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-tertiary hover:text-fg"
        >
          Today
        </button>
        {undated > 0 && <span className="ml-auto text-xs text-fg-subtle">{undated} task{undated === 1 ? '' : 's'} without a due date</span>}
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[640px] grid-cols-7 overflow-hidden rounded-xl border border-line" role="grid" aria-label={`Tasks due in ${format(month, 'MMMM yyyy')}`}>
          {WEEKDAYS.map((d) => (
            <div key={d} role="columnheader" className="bg-surface-secondary px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
              {d}
            </div>
          ))}
          {weeks.flat().map((day) => {
            const items = byDay.get(day) ?? [];
            const inMonth = day.startsWith(monthPrefix);
            return (
              <div
                key={day}
                role="gridcell"
                aria-label={`${day}${items.length ? `, ${items.length} due` : ''}`}
                className={`min-h-[5.5rem] border-t border-line p-1.5 ${inMonth ? 'bg-surface' : 'bg-surface-secondary/60'} [&:not(:nth-child(7n+1))]:border-l`}
              >
                <div className={`mb-1 text-[11px] font-semibold ${day === today ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand text-on-brand' : inMonth ? 'text-fg-muted' : 'text-fg-subtle'}`}>
                  {Number(day.slice(8))}
                </div>
                <ul className="space-y-1">
                  {items.slice(0, 3).map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(t.id)}
                        title={`${t.identifier}: ${t.title}`}
                        className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] font-medium hover:bg-surface-tertiary ${t.overdue ? 'text-danger' : 'text-fg'}`}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status]}`} aria-hidden="true" />
                        <span className="truncate">{t.title}</span>
                      </button>
                    </li>
                  ))}
                  {items.length > 3 && <li className="px-1 text-[11px] text-fg-subtle">+{items.length - 3} more</li>}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ---- Workload -------------------------------------------------------------------

export const WorkloadView = ({ workspaceId, projectId, refreshKey }: { workspaceId: string; projectId: string; refreshKey?: unknown }) => {
  const [state, setState] = useState<{ loading: boolean; error: string | null; people: WorkloadPerson[]; unassigned: { open: number; overdue: number } | null }>({
    loading: true,
    error: null,
    people: [],
    unassigned: null,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    getWorkload(workspaceId, projectId).then(
      (r) => !cancelled && setState({ loading: false, error: null, people: r.people, unassigned: r.unassigned }),
      (err) => !cancelled && setState({ loading: false, error: errorMessage(err, 'Could not load the workload.'), people: [], unassigned: null })
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, projectId, refreshKey, attempt]);

  if (state.loading) return <LoadingState label="Loading workload" />;
  if (state.error) return <ErrorState message={state.error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (state.people.length === 0) return <EmptyState title="Nobody has tasks yet" description="Assign tasks to see how work is spread across the team." />;
  const max = Math.max(1, ...state.people.map((p) => p.open));
  return (
    <div className="space-y-3">
      {state.unassigned && state.unassigned.open > 0 && (
        <p className="text-sm text-fg-muted">
          {state.unassigned.open} open task{state.unassigned.open === 1 ? ' is' : 's are'} unassigned{state.unassigned.overdue ? ` (${state.unassigned.overdue} overdue)` : ''}.
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-surface-secondary text-left text-xs font-semibold text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Person</th>
              <th scope="col" className="px-3 py-2">Open</th>
              <th scope="col" className="px-3 py-2">In progress</th>
              <th scope="col" className="px-3 py-2">Overdue</th>
              <th scope="col" className="px-3 py-2">Due this week</th>
              <th scope="col" className="px-3 py-2">Estimate</th>
              <th scope="col" className="px-3 py-2">Done (30 days)</th>
            </tr>
          </thead>
          <tbody>
            {state.people.map((p) => (
              <tr key={p.user.id} className="border-t border-line">
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-2 font-medium text-fg">
                    <Avatar name={personName(p.user)} size="xs" />
                    {personName(p.user)}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <span className="w-6 tabular-nums">{p.open}</span>
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-tertiary" aria-hidden="true">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${(p.open / max) * 100}%` }} />
                    </span>
                  </span>
                </td>
                <td className="px-3 py-2 tabular-nums">{p.inProgress}</td>
                <td className={`px-3 py-2 tabular-nums ${p.overdue ? 'font-semibold text-danger' : ''}`}>{p.overdue}</td>
                <td className="px-3 py-2 tabular-nums">{p.dueThisWeek}</td>
                <td className="px-3 py-2 tabular-nums">{p.estimateHours ? `${p.estimateHours} h` : '—'}</td>
                <td className="px-3 py-2 tabular-nums">{p.completedLast30}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---- Overview (report) ----------------------------------------------------------

const Stat = ({ label, value, tone }: { label: string; value: string | number; tone?: 'danger' | 'success' }) => (
  <div className="rounded-xl border border-line bg-surface p-4">
    <div className="text-xs font-semibold text-fg-muted">{label}</div>
    <div className={`mt-1 text-2xl font-bold tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-fg'}`}>{value}</div>
  </div>
);

const Bars = ({ title, rows }: { title: string; rows: { label: string; value: number; color?: string }[] }) => {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h3 className="mb-3 text-sm font-semibold text-fg">{title}</h3>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-3 text-xs">
            <span className="w-24 shrink-0 truncate text-fg-muted">{r.label}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-tertiary" aria-hidden="true">
              <span className={`block h-full rounded-full ${r.color ?? 'bg-brand'}`} style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
            <span className="w-8 text-right font-semibold tabular-nums text-fg">{r.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

export const ProjectOverview = ({ projectId, refreshKey }: { projectId: string; refreshKey?: unknown }) => {
  const [report, setReport] = useState<ProjectReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    getProjectReport(projectId).then(
      (r) => !cancelled && setReport(r),
      (err) => !cancelled && setError(errorMessage(err, 'Could not load the project report.'))
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, attempt]);

  if (error) return <ErrorState message={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!report) return <LoadingState label="Loading report" />;
  const { totals } = report;
  const weekMax = Math.max(1, ...report.completedByWeek.map((w) => w.count));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="All tasks" value={totals.all} />
        <Stat label="Open" value={totals.open} />
        <Stat label="Done" value={totals.done} tone="success" />
        <Stat label="Overdue" value={totals.overdue} tone={totals.overdue ? 'danger' : undefined} />
        <Stat label="Unassigned" value={totals.unassigned} />
        <Stat label="Complete" value={`${Math.round(totals.completionPercent)}%`} />
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-tertiary" role="progressbar" aria-label="Project completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(totals.completionPercent)}>
        <div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, totals.completionPercent)}%` }} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Bars title="By status" rows={TASK_STATUSES.map((s) => ({ label: STATUS_LABELS[s], value: report.byStatus[s] ?? 0, color: STATUS_DOT[s] }))} />
        <Bars title="By priority" rows={TASK_PRIORITIES.map((p) => ({ label: PRIORITY_LABELS[p], value: report.byPriority[p] ?? 0 }))} />
      </div>
      <section className="rounded-xl border border-line bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold text-fg">Completed per week</h3>
        <div className="flex h-32 items-end gap-2" role="list" aria-label="Tasks completed per week">
          {report.completedByWeek.map((w) => (
            <div key={w.weekStart} role="listitem" aria-label={`Week of ${formatDay(w.weekStart)}: ${w.count}`} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[10px] font-semibold tabular-nums text-fg-muted">{w.count}</span>
              <span className="w-full rounded-t bg-brand/80" style={{ height: `${Math.max(2, (w.count / weekMax) * 96)}px` }} aria-hidden="true" />
              <span className="text-[10px] text-fg-subtle">{formatDay(w.weekStart)}</span>
            </div>
          ))}
        </div>
      </section>
      {report.byAssignee.length > 0 && (
        <Bars
          title="By assignee (open)"
          rows={report.byAssignee.map((a) => ({ label: personName(a.user), value: a.open }))}
        />
      )}
    </div>
  );
};
