import { ArrowLeft, CalendarDays, FolderKanban, LayoutGrid, LineChart, List, Plus, Search, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { KanbanBoard } from '../../components/tasks/KanbanBoard';
import { blockersMessage, TaskDrawer } from '../../components/tasks/TaskDrawer';
import { NewTaskModal } from '../../components/tasks/TaskForms';
import { selectClass } from '../../components/tasks/TaskBits';
import { ProjectOverview, TaskCalendarView, TaskListView, WorkloadView } from '../../components/tasks/TaskViews';
import { Button, EmptyState, ErrorState, Tabs } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useTaskEvents } from '../../hooks/useTaskEvents';
import { errorMessage } from '../../lib/api/http';
import { getProject, listProjectMembers, PROJECT_STATUS_LABELS, PROJECT_STATUSES, projectCan, ProjectDetails, ProjectMember, ProjectStatus, updateProject } from '../../lib/api/projects';
import { createTask, listTasks, moveTask, PRIORITY_LABELS, TASK_PRIORITIES, TaskPriority, TaskStatus, TaskView } from '../../lib/api/tasks';
import { applyMove, BoardFilters, filterTasks, removeTask, upsertTask } from '../../lib/tasks/board';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { ProjectStatusBadge } from './ProjectsPage';

// Compact filter controls (selectClass is full-width for forms).
const FILTER_SELECT = 'h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-fg outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand-muted sm:w-auto';

/**
 * T.33 — one project: board / list / calendar / workload / overview, a filter
 * bar shared by the task views, and the task drawer (`?task=<id>`).
 */
type ViewId = 'board' | 'list' | 'calendar' | 'workload' | 'overview';
const VIEWS: { id: ViewId; label: string; icon: typeof List }[] = [
  { id: 'board', label: 'Board', icon: LayoutGrid },
  { id: 'list', label: 'List', icon: List },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'workload', label: 'Workload', icon: Users },
  { id: 'overview', label: 'Overview', icon: LineChart },
];

export const ProjectPage = () => {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { workspaceId, socket } = useWorkspace();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some((v) => v.id === params.get('view')) ? params.get('view') : 'board') as ViewId;
  const openTaskId = params.get('task');

  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [filters, setFilters] = useState<BoardFilters>({});
  const [newTask, setNewTask] = useState<TaskStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const tasksRef = useRef<TaskView[]>([]);
  tasksRef.current = tasks ?? [];

  const load = useCallback(async () => {
    setError(null);
    try {
      const [detail, page] = await Promise.all([getProject(projectId), listTasks(projectId, { parent: 'root', limit: 500 })]);
      setProject(detail);
      setTasks(page.tasks);
      listProjectMembers(projectId, { limit: 100 }).then(
        (r) => setMembers(r.members),
        () => setMembers([])
      );
    } catch (err) {
      setError({ message: errorMessage(err, 'This project could not be loaded.'), notFound: (err as { status?: number })?.status === 404 });
    }
  }, [projectId]);

  useEffect(() => {
    setProject(null);
    setTasks(null);
    void load();
  }, [load]);

  const bump = () => setRevision((r) => r + 1);

  /** Silent re-read of the board (after subtask changes). */
  const refreshTasks = useCallback(async () => {
    try {
      const page = await listTasks(projectId, { parent: 'root', limit: 500 });
      setTasks(page.tasks);
    } catch {
      // keep what is shown
    }
  }, [projectId]);

  useTaskEvents(socket, {
    onUpsert: (task) => {
      if (task.projectId !== projectId) return;
      if (task.parentId === null) setTasks((list) => (list ? upsertTask(list, task) : list));
      bump();
    },
    onDelete: (taskId) => {
      setTasks((list) => (list ? removeTask(list, taskId) : list));
      bump();
    },
  });

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: key === 'view' });
  };
  const openTask = (id: string) => setParam('task', id);
  const closeTask = useCallback(() => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('task');
      return next;
    });
  }, [setParams]);

  const visible = useMemo(() => filterTasks(tasks ?? [], filters, user?.id), [tasks, filters, user?.id]);
  const isLead = !!project && projectCan(project, 'manageTasks');
  // `createTask` comes from the server; older payloads without it fall back to "is a member or lead".
  const capabilityKnown = !!project?.capabilities && ('createTask' in project.capabilities || 'canCreateTask' in project.capabilities);
  const canCreateTask = !!project && !project.archived && (capabilityKnown ? projectCan(project, 'createTask') : project.myRole != null || isLead);
  const canUpdateProject = !!project && projectCan(project, 'update');

  // Optimistic move, persisted with the new neighbours; rolled back on refusal.
  const onMove = async (taskId: string, status: TaskStatus, index: number) => {
    const result = applyMove(visible, taskId, status, index);
    if (!result.changed) return;
    const before = tasksRef.current.find((t) => t.id === taskId);
    const moved = result.tasks.find((t) => t.id === taskId)!;
    setTasks((list) => (list ? upsertTask(list, moved) : list));
    try {
      const { task } = await moveTask(taskId, { status, prevId: result.prevId, nextId: result.nextId });
      setTasks((list) => (list ? upsertTask(list, task) : list));
      bump();
    } catch (err) {
      if (before) setTasks((list) => (list ? upsertTask(list, before) : list));
      toast.error(blockersMessage(err));
    }
  };

  const quickAdd = async (status: TaskStatus, title: string) => {
    try {
      const { task } = await createTask(projectId, { title, status });
      setTasks((list) => (list ? upsertTask(list, task) : list));
      bump();
      return true;
    } catch (err) {
      toast.error(errorMessage(err, 'The task could not be created.'));
      return false;
    }
  };

  const changeStatus = async (status: ProjectStatus) => {
    if (!project) return;
    try {
      const updated = await updateProject(project.id, { status });
      setProject((p) => (p ? { ...p, ...updated, capabilities: updated.capabilities ?? p.capabilities } : p));
    } catch (err) {
      toast.error(errorMessage(err, 'The project status could not be changed.'));
    }
  };

  if (error) {
    return (
      <div className="h-full overflow-y-auto bg-surface">
        {error.notFound ? (
          <EmptyState
            icon={<FolderKanban size={24} />}
            title="Project not found"
            description="It may have been deleted, or you don't have access to it."
            action={
              <Link to={`/${workspaceId}/projects`} className="text-sm font-semibold text-brand hover:underline">
                Back to projects
              </Link>
            }
          />
        ) : (
          <ErrorState message={error.message} onRetry={() => void load()} />
        )}
      </div>
    );
  }

  if (!project || !tasks) {
    return (
      <div className="flex h-full flex-col" role="status" aria-label="Loading project">
        <div className="flex h-16 items-center gap-3 border-b border-line px-5">
          <div className="skeleton h-5 w-48 rounded-md" />
        </div>
        <div className="flex gap-3 overflow-hidden p-5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="w-[17rem] shrink-0 space-y-2 rounded-xl border border-line p-3">
              <div className="skeleton h-3 w-20 rounded" />
              <div className="skeleton h-16 w-full rounded-lg" />
              <div className="skeleton h-16 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const assigneeChoices = members.map((m) => ({ id: m.userId, name: m.user.username }));
  const filtersActive = !!(filters.q || filters.assigneeId || filters.priority?.length || filters.label);
  const taskViews = view === 'board' || view === 'list' || view === 'calendar';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="shrink-0 border-b border-line px-4 pt-4 sm:px-6">
        <Link to={`/${workspaceId}/projects`} className="mb-2 inline-flex items-center gap-1 text-xs font-semibold text-fg-muted hover:text-fg">
          <ArrowLeft size={13} aria-hidden="true" /> Projects
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 truncate text-xl font-bold tracking-tight text-fg">{project.name}</h1>
          {project.key && <span className="font-mono text-xs font-semibold text-fg-subtle">{project.key}</span>}
          {canUpdateProject && !project.archived && project.status ? (
            <label className="inline-flex items-center">
              <span className="sr-only">Project status</span>
              <select value={project.status} onChange={(e) => void changeStatus(e.target.value as ProjectStatus)} className={`${selectClass} h-7 w-auto py-0 text-xs font-semibold`}>
                {PROJECT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PROJECT_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <ProjectStatusBadge project={project} />
          )}
          <span className="text-xs text-fg-subtle">
            {project.memberCount} member{project.memberCount === 1 ? '' : 's'} · {project.visibility === 'PRIVATE' ? 'Private' : 'Public'}
          </span>
          {canCreateTask && (
            <Button size="sm" className="ml-auto" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setNewTask('TODO')}>
              New task
            </Button>
          )}
        </div>
        {project.description && <p className="mt-1 line-clamp-2 max-w-3xl text-sm text-fg-muted">{project.description}</p>}
        {project.archived && <p className="mt-2 text-xs font-semibold text-warning">This project is archived — tasks are read-only.</p>}
        <Tabs
          className="mt-3 overflow-x-auto border-b-0"
          label="Project views"
          idPrefix="project-view"
          value={view}
          onChange={(id) => setParam('view', id === 'board' ? null : id)}
          tabs={VIEWS.map((v) => ({
            id: v.id,
            label: (
              <span className="inline-flex items-center gap-1.5">
                <v.icon size={14} aria-hidden="true" />
                {v.label}
              </span>
            ),
          }))}
        />
      </header>

      {taskViews && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-secondary px-4 py-2 sm:px-6" role="search" aria-label="Filter tasks">
          <label className="relative w-full sm:w-56">
            <span className="sr-only">Search tasks</span>
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
            <input
              type="search"
              value={filters.q ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              placeholder="Search tasks"
              className="h-8 w-full rounded-lg border border-line bg-surface pl-8 pr-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-brand focus:ring-2 focus:ring-brand-muted"
            />
          </label>
          <select aria-label="Filter by assignee" value={filters.assigneeId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, assigneeId: e.target.value || undefined }))} className={FILTER_SELECT}>
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
            {assigneeChoices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by priority"
            value={filters.priority?.[0] ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value ? [e.target.value as TaskPriority] : undefined }))}
            className={FILTER_SELECT}
          >
            <option value="">Any priority</option>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <input
            aria-label="Filter by label"
            value={filters.label ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value }))}
            placeholder="Label"
            className="h-8 w-28 rounded-lg border border-line bg-surface px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-brand focus:ring-2 focus:ring-brand-muted"
          />
          {filtersActive && (
            <button type="button" onClick={() => setFilters({})} className="text-xs font-semibold text-brand hover:underline">
              Clear filters
            </button>
          )}
          <span className="ml-auto text-xs text-fg-subtle" aria-live="polite">
            {visible.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      <div role="tabpanel" id={`project-view-panel-${view}`} aria-labelledby={`project-view-tab-${view}`} className={`min-h-0 flex-1 ${view === 'board' ? 'overflow-hidden p-3 sm:p-4' : 'overflow-y-auto p-4 sm:p-6'}`}>
        {view === 'board' &&
          (tasks.length === 0 && !canCreateTask ? (
            <EmptyState title="No tasks yet" description="Tasks added to this project appear here." />
          ) : (
            <KanbanBoard tasks={visible} readOnly={project.archived} canCreate={canCreateTask} onOpen={openTask} onMove={(id, s, i) => void onMove(id, s, i)} onQuickAdd={quickAdd} />
          ))}
        {view === 'list' && <TaskListView tasks={visible} onOpen={openTask} />}
        {view === 'calendar' && <TaskCalendarView tasks={visible} onOpen={openTask} />}
        {view === 'workload' && <WorkloadView workspaceId={workspaceId} projectId={project.id} refreshKey={revision} />}
        {view === 'overview' && <ProjectOverview projectId={project.id} refreshKey={revision} />}
      </div>

      {openTaskId && (
        <TaskDrawer
          key={openTaskId}
          taskId={openTaskId}
          projectTasks={tasks}
          members={members}
          canCreateTask={canCreateTask}
          onClose={closeTask}
          onOpenTask={openTask}
          onChanged={(task) => {
            if (task.parentId === null) setTasks((list) => (list ? upsertTask(list, task) : list));
            // A subtask changed: its parent's counts did too.
            else void refreshTasks();
            bump();
          }}
          onDeleted={(id) => {
            setTasks((list) => (list ? removeTask(list, id) : list));
            bump();
          }}
        />
      )}
      {newTask && (
        <NewTaskModal
          projectId={project.id}
          members={members}
          canAssignOthers={isLead}
          myId={user?.id}
          initialStatus={newTask}
          onClose={() => setNewTask(null)}
          onCreated={(task) => {
            setTasks((list) => (list ? upsertTask(list, task) : list));
            bump();
          }}
        />
      )}
    </div>
  );
};
