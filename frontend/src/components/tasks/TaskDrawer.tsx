import { formatDistanceToNow } from 'date-fns';
import { Link2, Loader2, Paperclip, Pencil, Plus, Send, Share2, Trash2, X } from 'lucide-react';
import { ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';
import { ApiError, errorMessage } from '../../lib/api/http';
import { ProjectMember } from '../../lib/api/projects';
import {
  ActivityView,
  addComment,
  addDependency,
  addTaskAttachment,
  createTask,
  deleteComment,
  deleteTask,
  editComment,
  getTask,
  personName,
  PRIORITY_LABELS,
  removeDependency,
  removeTaskAttachment,
  shareTask,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskDetail,
  TaskInput,
  TaskRef,
  TaskStatus,
  TaskView,
  updateTask,
  uploadFile,
  UserRef,
} from '../../lib/api/tasks';
import { MessageAttachment } from '../chat/MessageAttachment';
import { dateOnly, toDueIso, toStartIso } from '../../lib/tasks/board';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { Avatar } from '../ui/Avatar';
import { Button, ErrorState, useConfirm } from '../ui';
import { formatDay, PriorityIcon, selectClass, StatusBadge } from './TaskBits';

/**
 * T.33 — task detail side panel (`?task=<id>`). Every field saves on change
 * (text on blur/Enter); controls follow the server's `capabilities`, and the
 * server re-checks everything anyway.
 */
interface TaskDrawerProps {
  taskId: string;
  /** Root tasks of the project (dependency picker). */
  projectTasks: TaskView[];
  members: ProjectMember[];
  canCreateTask: boolean;
  onClose: () => void;
  onChanged: (task: TaskView) => void;
  onDeleted: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}

/** Blockers listed by a 409 "open dependencies" refusal. */
export const blockersMessage = (err: unknown) => {
  const blockers = (err instanceof ApiError ? (err.data as { blockers?: TaskRef[] } | undefined)?.blockers : undefined) ?? [];
  const base = errorMessage(err, 'The task could not be updated.');
  return blockers.length ? `${base} Open: ${blockers.map((b) => b.identifier).join(', ')}.` : base;
};

const Row = ({ label, children }: { label: string; children: ReactNode }) => {
  const id = useId();
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-2" role="group" aria-labelledby={id}>
      <span id={id} className="text-xs font-semibold text-fg-muted">
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
};

const activityText = (a: ActivityView): string => {
  const d = a.data ?? {};
  const name = (v: unknown) => (v && typeof v === 'object' ? personName(v as UserRef) : 'nobody');
  const status = (v: unknown) => (typeof v === 'string' && v in STATUS_LABELS ? STATUS_LABELS[v as TaskStatus] : String(v ?? ''));
  switch (a.type) {
    case 'created':
      return 'created the task';
    case 'status':
      return `changed status from ${status(d.from)} to ${status(d.to)}`;
    case 'priority':
      return `changed priority to ${PRIORITY_LABELS[d.to as keyof typeof PRIORITY_LABELS] ?? String(d.to ?? '')}`;
    case 'assignee':
      return d.to ? `assigned it to ${name(d.to)}` : 'unassigned it';
    case 'due_date':
      return d.to ? `set the due date to ${formatDay(String(d.to))}` : 'removed the due date';
    case 'start_date':
      return d.to ? `set the start date to ${formatDay(String(d.to))}` : 'removed the start date';
    case 'title':
      return 'renamed the task';
    case 'description':
      return 'edited the description';
    case 'estimate':
      return 'changed the estimate';
    case 'labels':
      return 'changed the labels';
    case 'comment':
      return 'commented';
    case 'dependency_added':
      return 'added a dependency';
    case 'dependency_removed':
      return 'removed a dependency';
    case 'subtask_added':
      return 'added a subtask';
    case 'shared':
      return typeof d.channelName === 'string' ? `shared it in #${d.channelName}` : 'shared it in a channel';
    default:
      return a.type.replace(/_/g, ' ');
  }
};

const inputClass =
  'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-brand focus:ring-2 focus:ring-brand-muted disabled:bg-surface-secondary disabled:text-fg-subtle';

export const TaskDrawer = ({ taskId, projectTasks, members, canCreateTask, onClose, onChanged, onDeleted, onOpenTask }: TaskDrawerProps) => {
  const { user } = useAuth();
  const { channels } = useWorkspace();
  const { confirm, dialog } = useConfirm();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();

  const load = useCallback(async () => {
    try {
      const detail = await getTask(taskId);
      setTask(detail);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'This task could not be loaded.'));
    }
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setError(null);
    void load();
  }, [load, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.focus();
  }, [taskId]);

  const save = async (input: TaskInput) => {
    if (!task) return false;
    setSaving(true);
    try {
      const { task: updated } = await updateTask(task.id, input);
      setTask((t) => (t ? { ...t, ...updated, project: t.project } : t));
      onChanged(updated);
      // Activity/blockers may have changed server-side.
      void load();
      return true;
    } catch (err) {
      toast.error(blockersMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-overlay md:bg-transparent" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-labelledby={titleId}
        className="fixed inset-y-0 right-0 z-[70] flex w-full max-w-[min(100vw,36rem)] flex-col border-l border-line bg-surface shadow-2xl outline-none animate-fade-in"
      >
        {!task && !error && (
          <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading task">
            <Loader2 size={22} className="animate-spin text-brand" aria-hidden="true" />
            <h2 id={titleId} className="sr-only">Loading task</h2>
          </div>
        )}
        {error && (
          <div className="flex flex-1 flex-col">
            <div className="flex justify-end p-3">
              <button type="button" onClick={onClose} aria-label="Close task" className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-tertiary hover:text-fg">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <h2 id={titleId} className="sr-only">Task unavailable</h2>
            <ErrorState message={error} onRetry={() => setAttempt((a) => a + 1)} />
          </div>
        )}
        {task && (
          <DrawerBody
            task={task}
            titleId={titleId}
            saving={saving}
            members={members}
            projectTasks={projectTasks}
            canCreateTask={canCreateTask}
            myId={user?.id}
            channels={channels.filter((c) => !c.isDM)}
            onClose={onClose}
            onSave={save}
            onReload={load}
            onOpenTask={onOpenTask}
            onChanged={onChanged}
            onDelete={async () => {
              const ok = await confirm({
                title: `Delete ${task.identifier}?`,
                message: task.subtaskCount > 0 ? `This also deletes its ${task.subtaskCount} subtask(s). It can't be undone.` : "This can't be undone.",
                confirmLabel: 'Delete task',
                tone: 'danger',
              });
              if (!ok) return;
              try {
                await deleteTask(task.id);
                toast.success(`${task.identifier} deleted`);
                onDeleted(task.id);
                onClose();
              } catch (err) {
                toast.error(errorMessage(err, 'The task could not be deleted.'));
              }
            }}
          />
        )}
      </aside>
      {dialog}
    </>
  );
};

interface DrawerBodyProps {
  task: TaskDetail;
  titleId: string;
  saving: boolean;
  members: ProjectMember[];
  projectTasks: TaskView[];
  canCreateTask: boolean;
  myId: string | undefined;
  channels: { id: string; name: string }[];
  onClose: () => void;
  onSave: (input: TaskInput) => Promise<boolean>;
  onReload: () => Promise<void>;
  onOpenTask: (id: string) => void;
  onChanged: (task: TaskView) => void;
  onDelete: () => void;
}

const DrawerBody = ({ task, titleId, saving, members, projectTasks, canCreateTask, myId, channels, onClose, onSave, onReload, onOpenTask, onChanged, onDelete }: DrawerBodyProps) => {
  const caps = task.capabilities;
  const readOnly = task.project.archived;
  const canUpdate = caps.update && !readOnly;
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [labels, setLabels] = useState(task.labels.join(', '));
  const [estimate, setEstimate] = useState(task.estimateHours?.toString() ?? '');
  const [actual, setActual] = useState(task.actualHours?.toString() ?? '');
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? '');
    setLabels(task.labels.join(', '));
    setEstimate(task.estimateHours?.toString() ?? '');
    setActual(task.actualHours?.toString() ?? '');
  }, [task.id, task.title, task.description, task.labels, task.estimateHours, task.actualHours]);

  const saveTitle = async () => {
    const value = title.trim();
    if (!value) {
      setTitle(task.title);
      toast.error('A task needs a title.');
      return;
    }
    if (value !== task.title && !(await onSave({ title: value }))) setTitle(task.title);
  };

  const saveHours = async (field: 'estimateHours' | 'actualHours', raw: string, reset: () => void) => {
    const trimmed = raw.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 10_000)) {
      toast.error('Hours must be a number between 0 and 10000.');
      reset();
      return;
    }
    if (value === task[field]) return;
    if (!(await onSave({ [field]: value }))) reset();
  };

  const saveLabels = async () => {
    const next = Array.from(new Set(labels.split(',').map((l) => l.trim()).filter(Boolean))).slice(0, 10);
    if (next.join('|') === task.labels.join('|')) return;
    if (!(await onSave({ labels: next }))) setLabels(task.labels.join(', '));
  };

  // Assignee choices follow the capabilities (members may only take/release a task themselves).
  const assigneeOptions: { value: string; label: string }[] = [{ value: '', label: 'Unassigned' }];
  if (caps.assignOthers) {
    for (const m of members) assigneeOptions.push({ value: m.userId, label: m.user.username });
  } else if (caps.assignSelf && myId) {
    assigneeOptions.push({ value: myId, label: 'Me' });
  }
  if (task.assignee && !assigneeOptions.some((o) => o.value === task.assignee!.id)) {
    assigneeOptions.push({ value: task.assignee.id, label: personName(task.assignee) });
  }
  const assigneeLocked = readOnly || (!caps.assignOthers && !(caps.assignSelf && (!task.assignee || task.assignee.id === myId)));

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <span className="font-mono text-xs font-semibold text-fg-subtle">{task.identifier}</span>
        <span className="truncate text-xs text-fg-subtle">in {task.project.name}</span>
        {saving && <Loader2 size={14} className="animate-spin text-brand" aria-label="Saving" />}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSharing((v) => !v)}
            aria-expanded={sharing}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-fg-muted hover:bg-surface-tertiary hover:text-fg"
          >
            <Share2 size={14} aria-hidden="true" /> Share
          </button>
          {caps.delete && !readOnly && (
            <button type="button" onClick={onDelete} aria-label={`Delete ${task.identifier}`} className="rounded-lg p-1.5 text-fg-subtle hover:bg-danger-soft hover:text-danger">
              <Trash2 size={15} aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close task" className="rounded-lg p-1.5 text-fg-subtle hover:bg-surface-tertiary hover:text-fg">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {sharing && <SharePanel taskId={task.id} channels={channels} onDone={() => setSharing(false)} onShared={onReload} />}
        {readOnly && <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs font-semibold text-warning">This project is archived — its tasks are read-only.</p>}
        {task.parent && (
          <button type="button" onClick={() => onOpenTask(task.parent!.id)} className="text-xs font-semibold text-brand hover:underline">
            ↑ Subtask of {task.parent.identifier} {task.parent.title}
          </button>
        )}

        {canUpdate ? (
          <div>
            <label htmlFor={`${titleId}-input`} className="sr-only">
              Title
            </label>
            <h2 id={titleId} className="sr-only">
              {task.title}
            </h2>
            <input
              id={`${titleId}-input`}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              className="w-full rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-lg font-semibold text-fg outline-none hover:border-line focus:border-brand focus:ring-2 focus:ring-brand-muted"
            />
          </div>
        ) : (
          <h2 id={titleId} className="px-1.5 text-lg font-semibold text-fg">
            {task.title}
          </h2>
        )}

        <div className="space-y-2.5">
          <Row label="Status">
            <select
              aria-label="Status"
              value={task.status}
              disabled={readOnly || !caps.changeStatus}
              onChange={(e) => void onSave({ status: e.target.value as TaskStatus })}
              className={selectClass}
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s} disabled={s === 'DONE' && !caps.complete && task.status !== 'DONE'}>
                  {STATUS_LABELS[s]}
                  {s === 'DONE' && !caps.complete && task.status !== 'DONE' ? ' (lead review)' : ''}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Priority">
            <select aria-label="Priority" value={task.priority} disabled={!canUpdate} onChange={(e) => void onSave({ priority: e.target.value as TaskView['priority'] })} className={selectClass}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Assignee">
            <select
              aria-label="Assignee"
              value={task.assignee?.id ?? ''}
              disabled={assigneeLocked}
              onChange={(e) => void onSave({ assigneeId: e.target.value || null })}
              className={selectClass}
            >
              {assigneeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Start date">
            <input
              type="date"
              aria-label="Start date"
              value={dateOnly(task.startDate)}
              disabled={!canUpdate}
              onChange={(e) => void onSave({ startDate: toStartIso(e.target.value) })}
              className={inputClass}
            />
          </Row>
          <Row label="Due date">
            <input
              type="date"
              aria-label="Due date"
              value={dateOnly(task.dueDate)}
              min={dateOnly(task.startDate) || undefined}
              disabled={!canUpdate}
              onChange={(e) => void onSave({ dueDate: toDueIso(e.target.value) })}
              className={`${inputClass} ${task.overdue ? 'border-danger text-danger' : ''}`}
            />
          </Row>
          <Row label="Estimate (h)">
            <input
              inputMode="decimal"
              aria-label="Estimate in hours"
              value={estimate}
              disabled={!canUpdate}
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => void saveHours('estimateHours', estimate, () => setEstimate(task.estimateHours?.toString() ?? ''))}
              placeholder="—"
              className={inputClass}
            />
          </Row>
          <Row label="Actual (h)">
            <input
              inputMode="decimal"
              aria-label="Actual hours"
              value={actual}
              disabled={!canUpdate}
              onChange={(e) => setActual(e.target.value)}
              onBlur={() => void saveHours('actualHours', actual, () => setActual(task.actualHours?.toString() ?? ''))}
              placeholder="—"
              className={inputClass}
            />
          </Row>
          <Row label="Labels">
            <input
              aria-label="Labels"
              value={labels}
              disabled={!canUpdate}
              onChange={(e) => setLabels(e.target.value)}
              onBlur={() => void saveLabels()}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              placeholder="Comma separated"
              className={inputClass}
            />
          </Row>
          {task.creator && (
            <Row label="Created by">
              <span className="text-sm text-fg-muted">
                {personName(task.creator)} · {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
              </span>
            </Row>
          )}
        </div>

        <section aria-label="Description">
          <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-fg-muted">Description</h3>
          {canUpdate ? (
            <textarea
              aria-label="Description"
              value={description}
              maxLength={20_000}
              rows={5}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                const next = description.trim() ? description : null;
                if (next !== task.description) void onSave({ description: next }).then((ok) => !ok && setDescription(task.description ?? ''));
              }}
              placeholder="Add details, acceptance criteria, links…"
              className={`${inputClass} resize-y`}
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-fg">{task.description || <span className="text-fg-subtle">No description.</span>}</p>
          )}
        </section>

        <Attachments task={task} canEdit={canUpdate} onReload={onReload} />
        <Subtasks task={task} canCreate={canCreateTask && !readOnly} onOpenTask={onOpenTask} onChanged={onChanged} onReload={onReload} />
        <Dependencies task={task} canEdit={canUpdate} projectTasks={projectTasks} onOpenTask={onOpenTask} onReload={onReload} />
        <Comments task={task} canComment={caps.comment && !readOnly} onReload={onReload} />

        <section aria-label="Activity">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-fg-muted">Activity</h3>
          {task.activity.length === 0 ? (
            <p className="text-xs text-fg-subtle">No activity yet.</p>
          ) : (
            <ol className="space-y-2 border-l border-line pl-3">
              {task.activity.map((a) => (
                <li key={a.id} className="text-xs text-fg-muted">
                  <span className="font-semibold text-fg">{a.actor ? personName(a.actor) : 'Someone'}</span> {activityText(a)}
                  <span className="text-fg-subtle"> · {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
};

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Files on a task: private attachments (signed links), uploaded then linked. */
const Attachments = ({ task, canEdit, onReload }: { task: TaskDetail; canEdit: boolean; onReload: () => Promise<void> }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const attach = async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      toast.error('Files must be under 25 MB.');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUpload({ name: file.name, percent: 0 });
    try {
      const uploaded = await uploadFile(file, { signal: controller.signal, onProgress: (percent) => setUpload({ name: file.name, percent }) });
      if (controller.signal.aborted) return;
      await addTaskAttachment(task.id, uploaded.id);
      await onReload();
    } catch (err) {
      if (!controller.signal.aborted) toast.error(errorMessage(err, 'The file could not be attached.'));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setUpload(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (attachmentId: string, name: string) => {
    try {
      await removeTaskAttachment(task.id, attachmentId);
      await onReload();
    } catch (err) {
      toast.error(errorMessage(err, `${name} could not be removed.`));
    }
  };

  if (task.attachments.length === 0 && !canEdit) return null;
  return (
    <section aria-label="Files">
      <div className="mb-2 flex items-center">
        <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">Files {task.attachments.length > 0 && `(${task.attachments.length})`}</h3>
        {canEdit && (
          <>
            <input ref={inputRef} type="file" hidden aria-hidden="true" tabIndex={-1} data-testid="task-file-input" onChange={(e) => e.target.files?.[0] && void attach(e.target.files[0])} />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={!!upload}
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-tertiary hover:text-fg disabled:opacity-50"
            >
              <Paperclip size={13} aria-hidden="true" /> Attach file
            </button>
          </>
        )}
      </div>
      {upload && (
        <div className="mb-2 flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
          <span className="max-w-[10rem] truncate">{upload.name}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-tertiary">
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${upload.percent}%` }} />
          </div>
          <span className="tabular-nums">{upload.percent}%</span>
          <button type="button" onClick={() => abortRef.current?.abort()} aria-label={`Cancel uploading ${upload.name}`} className="rounded p-0.5 hover:bg-surface-tertiary">
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      {task.attachments.length === 0 ? (
        !upload && <p className="text-xs text-fg-subtle">No files yet.</p>
      ) : (
        <ul className="space-y-1">
          {task.attachments.map((a) => (
            <li key={a.id} className="flex items-start gap-2 [&>div:first-child>div]:mt-0">
              <div className="min-w-0 flex-1">
                <MessageAttachment fileUrl={a.url} fileName={a.name} fileType={a.type} compact />
              </div>
              {canEdit && (
                <button type="button" onClick={() => void remove(a.id, a.name)} aria-label={`Remove ${a.name}`} className="mt-1 rounded p-1 text-fg-subtle hover:bg-danger-soft hover:text-danger">
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const Subtasks = ({ task, canCreate, onOpenTask, onChanged, onReload }: { task: TaskDetail; canCreate: boolean; onOpenTask: (id: string) => void; onChanged: (t: TaskView) => void; onReload: () => Promise<void> }) => {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const { task: created } = await createTask(task.projectId, { title: value, parentId: task.id });
      onChanged(created);
      setTitle('');
      await onReload();
    } catch (err) {
      toast.error(errorMessage(err, 'The subtask could not be added.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Subtasks">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-fg-muted">
        Subtasks {task.subtasks.length > 0 && <span className="font-semibold normal-case text-fg-subtle">({task.subtasksDone}/{task.subtaskCount} done)</span>}
      </h3>
      <ul className="space-y-1">
        {task.subtasks.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => onOpenTask(s.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-secondary">
              <StatusBadge status={s.status} />
              <span className="font-mono text-[11px] text-fg-subtle">{s.identifier}</span>
              <span className={`truncate ${s.status === 'DONE' ? 'text-fg-subtle line-through' : 'text-fg'}`}>{s.title}</span>
              <PriorityIcon priority={s.priority} />
            </button>
          </li>
        ))}
      </ul>
      {canCreate && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-label="New subtask title" placeholder="Add a subtask" className={inputClass} />
          <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={!title.trim()} icon={<Plus size={14} aria-hidden="true" />}>
            Add
          </Button>
        </form>
      )}
    </section>
  );
};

const Dependencies = ({ task, canEdit, projectTasks, onOpenTask, onReload }: { task: TaskDetail; canEdit: boolean; projectTasks: TaskView[]; onOpenTask: (id: string) => void; onReload: () => Promise<void> }) => {
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const taken = new Set([task.id, ...task.blockedBy.map((b) => b.id)]);
  const candidates = projectTasks.filter((t) => !taken.has(t.id));

  const add = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await addDependency(task.id, pick);
      setPick('');
      await onReload();
    } catch (err) {
      toast.error(errorMessage(err, 'The dependency could not be added.'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (dependsOnId: string) => {
    try {
      await removeDependency(task.id, dependsOnId);
      await onReload();
    } catch (err) {
      toast.error(errorMessage(err, 'The dependency could not be removed.'));
    }
  };

  const refList = (refs: TaskRef[], removable: boolean) => (
    <ul className="space-y-1">
      {refs.map((r) => (
        <li key={r.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-secondary">
          <StatusBadge status={r.status} />
          <button type="button" onClick={() => onOpenTask(r.id)} className="min-w-0 flex-1 truncate text-left text-fg hover:text-brand">
            <span className="mr-1.5 font-mono text-[11px] text-fg-subtle">{r.identifier}</span>
            {r.title}
          </button>
          {removable && (
            <button type="button" onClick={() => void remove(r.id)} aria-label={`Remove dependency on ${r.identifier}`} className="rounded p-1 text-fg-subtle hover:bg-danger-soft hover:text-danger">
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-label="Dependencies">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-fg-muted">
        <Link2 size={13} aria-hidden="true" /> Dependencies
      </h3>
      <div className="space-y-2">
        <div>
          <p className="mb-1 text-xs font-semibold text-fg-muted">Blocked by</p>
          {task.blockedBy.length ? refList(task.blockedBy, canEdit) : <p className="px-2 text-xs text-fg-subtle">Nothing — this task can be completed any time.</p>}
        </div>
        {task.blocking.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold text-fg-muted">Blocking</p>
            {refList(task.blocking, false)}
          </div>
        )}
        {canEdit && candidates.length > 0 && (
          <div className="flex gap-2">
            <select aria-label="Add a task this one depends on" value={pick} onChange={(e) => setPick(e.target.value)} className={selectClass}>
              <option value="">Depends on…</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.identifier} · {t.title}
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" onClick={() => void add()} disabled={!pick} loading={busy}>
              Add
            </Button>
          </div>
        )}
      </div>
    </section>
  );
};

const Comments = ({ task, canComment, onReload }: { task: TaskDetail; canComment: boolean; onReload: () => Promise<void> }) => {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const post = async () => {
    const value = body.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await addComment(task.id, value);
      setBody('');
      await onReload();
    } catch (err) {
      toast.error(errorMessage(err, 'The comment could not be posted.'));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const value = editing.body.trim();
    if (!value) return;
    try {
      await editComment(editing.id, value);
      setEditing(null);
      await onReload();
    } catch (err) {
      toast.error(errorMessage(err, 'The comment could not be saved.'));
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteComment(id);
      await onReload();
    } catch (err) {
      toast.error(errorMessage(err, 'The comment could not be deleted.'));
    }
  };

  return (
    <section aria-label="Comments">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-fg-muted">Comments {task.commentCount > 0 && `(${task.commentCount})`}</h3>
      <ul className="space-y-3">
        {task.comments.map((c) => (
          <li key={c.id} className="flex gap-2.5">
            <Avatar name={c.author ? personName(c.author) : '?'} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-fg">{c.author ? personName(c.author) : 'Former member'}</span>
                <span className="text-fg-subtle">
                  {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                  {c.editedAt ? ' · edited' : ''}
                </span>
                <span className="ml-auto flex gap-0.5">
                  {c.canEdit && editing?.id !== c.id && (
                    <button type="button" onClick={() => setEditing({ id: c.id, body: c.body })} aria-label="Edit comment" className="rounded p-1 text-fg-subtle hover:bg-surface-tertiary hover:text-fg">
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                  )}
                  {c.canDelete && (
                    <button type="button" onClick={() => void remove(c.id)} aria-label="Delete comment" className="rounded p-1 text-fg-subtle hover:bg-danger-soft hover:text-danger">
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  )}
                </span>
              </div>
              {editing?.id === c.id ? (
                <div className="mt-1 space-y-1.5">
                  <textarea
                    aria-label="Edit comment"
                    value={editing.body}
                    maxLength={5000}
                    rows={3}
                    onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                    className={`${inputClass} resize-y`}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void saveEdit()} disabled={!editing.body.trim()}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg">{c.body}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canComment && (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void post();
          }}
        >
          <textarea
            aria-label="Write a comment"
            value={body}
            maxLength={5000}
            rows={2}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void post();
              }
            }}
            placeholder="Write a comment (Ctrl/⌘+Enter to post)"
            className={`${inputClass} resize-y`}
          />
          <Button type="submit" size="sm" loading={busy} disabled={!body.trim()} aria-label="Post comment" icon={<Send size={14} aria-hidden="true" />} />
        </form>
      )}
    </section>
  );
};

const SharePanel = ({ taskId, channels, onDone, onShared }: { taskId: string; channels: { id: string; name: string }[]; onDone: () => void; onShared: () => Promise<void> }) => {
  const [channelId, setChannelId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const share = async () => {
    if (!channelId) return;
    setBusy(true);
    try {
      await shareTask(taskId, channelId, note.trim() || undefined);
      const name = channels.find((c) => c.id === channelId)?.name;
      toast.success(name ? `Shared in #${name}` : 'Shared');
      onDone();
      await onShared();
    } catch (err) {
      toast.error(errorMessage(err, 'The task could not be shared.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-secondary p-3">
      <p className="text-xs font-semibold text-fg-muted">Share this task in a channel</p>
      {channels.length === 0 ? (
        <p className="text-xs text-fg-subtle">You aren't in any channels of this workspace.</p>
      ) : (
        <>
          <select aria-label="Channel to share in" value={channelId} onChange={(e) => setChannelId(e.target.value)} className={selectClass}>
            <option value="">Choose a channel…</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <input aria-label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" className={inputClass} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void share()} disabled={!channelId} loading={busy}>
              Share
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
