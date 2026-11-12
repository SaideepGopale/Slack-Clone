import { FolderKanban, Globe2, Lock, Plus, Search, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CreateProjectModal } from '../../components/tasks/TaskForms';
import { Badge, BadgeTone, Button, EmptyState, ErrorState, Tabs } from '../../components/ui';
import { errorMessage } from '../../lib/api/http';
import { listProjects, PROJECT_STATUS_LABELS, ProjectStatus, ProjectSummary } from '../../lib/api/projects';
import { useWorkspace } from '../workspace/WorkspaceContext';

/** T.33 — the workspace's projects: status, progress, members; create one. */

const STATUS_TONE: Record<ProjectStatus, BadgeTone> = { PLANNING: 'neutral', ACTIVE: 'brand', ON_HOLD: 'warning', COMPLETED: 'success' };

export const ProjectStatusBadge = ({ project }: { project: Pick<ProjectSummary, 'archived' | 'status'> }) =>
  project.archived ? <Badge>Archived</Badge> : project.status ? <Badge tone={STATUS_TONE[project.status]}>{PROJECT_STATUS_LABELS[project.status]}</Badge> : null;

const ProjectCard = ({ project, workspaceId }: { project: ProjectSummary; workspaceId: string }) => {
  const counts = project.taskCounts;
  const percent = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
  return (
    <Link
      to={`/${workspaceId}/projects/${project.id}`}
      className="group flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-sm transition-[border-color,box-shadow] hover:border-border-strong hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-fg group-hover:text-brand">{project.name}</h2>
          {project.key && <span className="font-mono text-[11px] font-semibold text-fg-subtle">{project.key}</span>}
        </div>
        <ProjectStatusBadge project={project} />
      </div>
      {project.description ? <p className="line-clamp-2 text-sm text-fg-muted">{project.description}</p> : <p className="text-sm text-fg-subtle">No description</p>}
      {counts && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-fg-muted">
            <span>
              {counts.open} open{counts.overdue > 0 && <span className="font-semibold text-danger"> · {counts.overdue} overdue</span>}
            </span>
            <span className="tabular-nums">{percent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-tertiary" role="progressbar" aria-label={`${project.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      <div className="mt-auto flex items-center gap-3 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1">
          {project.visibility === 'PRIVATE' ? <Lock size={12} aria-hidden="true" /> : <Globe2 size={12} aria-hidden="true" />}
          {project.visibility === 'PRIVATE' ? 'Private' : 'Public'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Users size={12} aria-hidden="true" />
          {project.memberCount} member{project.memberCount === 1 ? '' : 's'}
        </span>
        {project.myRole && <span className="ml-auto font-semibold text-fg-muted">{project.myRole === 'OWNER' ? 'Owner' : 'Member'}</span>}
      </div>
    </Link>
  );
};

const CardSkeleton = () => (
  <div className="space-y-3 rounded-2xl border border-line bg-surface p-5" aria-hidden="true">
    <div className="skeleton h-4 w-2/3 rounded-md" />
    <div className="skeleton h-3 w-full rounded-md" />
    <div className="skeleton h-1.5 w-full rounded-full" />
    <div className="skeleton h-3 w-1/3 rounded-md" />
  </div>
);

export const ProjectsPage = () => {
  const { workspaceId, socket } = useWorkspace();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setError(null);
    try {
      const page = await listProjects(workspaceId, { status, ...(debounced ? { q: debounced } : {}) });
      if (request !== requestRef.current) return;
      setProjects(page.projects);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (request === requestRef.current) setError(errorMessage(err, 'Projects could not be loaded.'));
    }
  }, [workspaceId, status, debounced]);

  useEffect(() => {
    setProjects(null);
    void load();
  }, [load]);

  // Another member created/changed/archived a project: refresh the list.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => void load();
    const events = ['project:created', 'project:updated', 'project:removed'];
    for (const e of events) socket.on(e, refresh);
    return () => {
      for (const e of events) socket.off(e, refresh);
    };
  }, [socket, load]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listProjects(workspaceId, { status, cursor: nextCursor, ...(debounced ? { q: debounced } : {}) });
      setProjects((list) => [...(list ?? []), ...page.projects.filter((p) => !list?.some((x) => x.id === p.id))]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err, 'More projects could not be loaded.'));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-secondary">
      <div className="mx-auto max-w-6xl p-4 sm:p-8">
        <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-fg">Projects</h1>
            <p className="mt-1 text-sm text-fg-muted">Plan work, track tasks and see progress across your team.</p>
          </div>
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setCreating(true)}>
            New project
          </Button>
        </header>

        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Tabs
            label="Project status"
            idPrefix="projects"
            value={status}
            onChange={(v) => setStatus(v as 'active' | 'archived')}
            tabs={[
              { id: 'active', label: 'Active' },
              { id: 'archived', label: 'Archived' },
            ]}
          />
          <label className="relative sm:ml-auto sm:w-72">
            <span className="sr-only">Search projects</span>
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
              className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-brand focus:ring-2 focus:ring-brand-muted"
            />
          </label>
        </div>

        <div role="tabpanel" id={`projects-panel-${status}`} aria-labelledby={`projects-tab-${status}`}>
          {error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : projects === null ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading projects">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={<FolderKanban size={24} />}
              title={debounced ? 'No projects match your search' : status === 'archived' ? 'No archived projects' : 'No projects yet'}
              description={debounced || status === 'archived' ? undefined : 'Create a project to organise tasks, owners and deadlines.'}
              action={
                !debounced && status === 'active' ? (
                  <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setCreating(true)}>
                    New project
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {projects.map((p) => (
                  <ProjectCard key={p.id} project={p} workspaceId={workspaceId} />
                ))}
              </div>
              {nextCursor && (
                <div className="mt-6 flex justify-center">
                  <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {creating && <CreateProjectModal workspaceId={workspaceId} onClose={() => setCreating(false)} onCreated={(p) => navigate(`/${workspaceId}/projects/${p.id}`)} />}
    </div>
  );
};
