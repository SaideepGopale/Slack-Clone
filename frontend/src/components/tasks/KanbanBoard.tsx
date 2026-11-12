import { ArrowDown, ArrowRight, ArrowUp, CheckSquare, Link2, MessageSquare, MoreHorizontal, Plus } from 'lucide-react';
import { DragEvent, KeyboardEvent, useRef, useState } from 'react';
import { STATUS_LABELS, TASK_STATUSES, TaskStatus, TaskView } from '../../lib/api/tasks';
import { groupByStatus } from '../../lib/tasks/board';
import { Menu, MenuItem } from '../ui';
import { AssigneeAvatar, DueChip, PriorityIcon, STATUS_DOT } from './TaskBits';

/**
 * T.33 — Kanban board. Columns follow the status order of the contract.
 * Cards move by native drag-and-drop (drop position = between the cards
 * under the pointer) or, without a mouse, through each card's "Move task"
 * menu (to another column, or up/down within the column). The parent applies
 * the move optimistically and persists it.
 */
interface KanbanBoardProps {
  tasks: TaskView[];
  readOnly?: boolean;
  canCreate?: boolean;
  onOpen: (taskId: string) => void;
  /** `index` is the position in the target column's visible cards (moving card excluded). */
  onMove: (taskId: string, status: TaskStatus, index: number) => void;
  onQuickAdd?: (status: TaskStatus, title: string) => Promise<boolean>;
}

const DRAG_TYPE = 'application/x-smartconnect-task';

export const KanbanBoard = ({ tasks, readOnly = false, canCreate = false, onOpen, onMove, onQuickAdd }: KanbanBoardProps) => {
  const columns = groupByStatus(tasks);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ status: TaskStatus; index: number } | null>(null);
  const columnRefs = useRef<Partial<Record<TaskStatus, HTMLOListElement | null>>>({});

  const indexAt = (status: TaskStatus, clientY: number) => {
    const list = columnRefs.current[status];
    if (!list) return 0;
    const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-task-card]')).filter((el) => el.dataset.taskCard !== dragId);
    let index = 0;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.top + rect.height / 2 < clientY) index++;
    }
    return index;
  };

  const onDragOver = (e: DragEvent, status: TaskStatus) => {
    if (readOnly || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const index = indexAt(status, e.clientY);
    if (dropTarget?.status !== status || dropTarget.index !== index) setDropTarget({ status, index });
  };

  const onDrop = (e: DragEvent, status: TaskStatus) => {
    if (readOnly) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData('text/plain') || dragId;
    const index = dropTarget?.status === status ? dropTarget.index : indexAt(status, e.clientY);
    setDragId(null);
    setDropTarget(null);
    if (id) onMove(id, status, index);
  };

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto pb-3" role="list" aria-label="Task board">
      {TASK_STATUSES.map((status) => {
        const cards = columns[status];
        // Drop indexes count the column's cards without the one being dragged
        // (it stays rendered, dimmed, so the browser keeps its drag source).
        const visibleWithoutDrag = cards.filter((t) => t.id !== dragId);
        let slot = 0;
        return (
          <section
            key={status}
            role="listitem"
            aria-label={`${STATUS_LABELS[status]} column, ${cards.length} task${cards.length === 1 ? '' : 's'}`}
            className={`flex w-[17rem] shrink-0 flex-col rounded-xl border bg-surface-secondary transition-colors ${
              dropTarget?.status === status ? 'border-brand/60' : 'border-line'
            }`}
            onDragOver={(e) => onDragOver(e, status)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t?.status === status ? null : t));
            }}
            onDrop={(e) => onDrop(e, status)}
          >
            <header className="flex items-center gap-2 px-3 pb-2 pt-3">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">{STATUS_LABELS[status]}</h3>
              <span className="ml-auto rounded-md bg-surface-tertiary px-1.5 text-[11px] font-semibold tabular-nums text-fg-subtle">{cards.length}</span>
            </header>
            <ol ref={(el) => void (columnRefs.current[status] = el)} className="flex min-h-[3rem] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {cards.map((task, i) => {
                const dragging = task.id === dragId;
                const markerHere = !dragging && dropTarget?.status === status && dropTarget.index === slot;
                if (!dragging) slot++;
                return (
                <li key={task.id} className={`flex flex-col gap-2 ${dragging ? 'opacity-40' : ''}`}>
                  {markerHere && <DropMarker />}
                  <TaskCard
                    task={task}
                    column={cards}
                    index={i}
                    readOnly={readOnly}
                    onOpen={onOpen}
                    onMove={onMove}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, task.id);
                      e.dataTransfer.setData('text/plain', task.id);
                      e.dataTransfer.effectAllowed = 'move';
                      // Defer so the browser snapshots the card before it is hidden.
                      setTimeout(() => setDragId(task.id), 0);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTarget(null);
                    }}
                  />
                </li>
                );
              })}
              {dropTarget?.status === status && dropTarget.index >= visibleWithoutDrag.length && <DropMarker />}
              {cards.length === 0 && !dropTarget && <li className="px-1 py-3 text-center text-xs text-fg-subtle">No tasks</li>}
            </ol>
            {canCreate && !readOnly && onQuickAdd && <QuickAdd status={status} onAdd={onQuickAdd} />}
          </section>
        );
      })}
    </div>
  );
};

const DropMarker = () => <div className="h-1 rounded-full bg-brand" aria-hidden="true" />;

interface TaskCardProps {
  task: TaskView;
  column: TaskView[];
  index: number;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TaskStatus, index: number) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}

const TaskCard = ({ task, column, index, readOnly, onOpen, onMove, onDragStart, onDragEnd }: TaskCardProps) => {
  const moveItems: MenuItem[] = readOnly
    ? []
    : [
        ...(index > 0 ? [{ id: 'up', label: 'Move up', icon: <ArrowUp size={14} aria-hidden="true" />, onSelect: () => onMove(task.id, task.status, index - 1) }] : []),
        ...(index < column.length - 1
          ? [{ id: 'down', label: 'Move down', icon: <ArrowDown size={14} aria-hidden="true" />, onSelect: () => onMove(task.id, task.status, index + 1) }]
          : []),
        ...TASK_STATUSES.filter((s) => s !== task.status).map((s) => ({
          id: `to-${s}`,
          label: `Move to ${STATUS_LABELS[s]}`,
          icon: <ArrowRight size={14} aria-hidden="true" />,
          // Lands at the top of the target column.
          onSelect: () => onMove(task.id, s, 0),
        })),
      ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(task.id);
    }
  };

  return (
    <div
      data-task-card={task.id}
      draggable={!readOnly}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      role="button"
      tabIndex={0}
      aria-label={`${task.identifier}: ${task.title}`}
      onClick={() => onOpen(task.id)}
      onKeyDown={onKeyDown}
      className={`group relative cursor-pointer rounded-lg border border-line bg-surface p-2.5 text-left shadow-sm transition-[border-color,box-shadow] hover:border-border-strong hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
        !readOnly ? 'active:cursor-grabbing' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="font-mono text-[11px] font-semibold text-fg-subtle">{task.identifier}</span>
        <div className="ml-auto -mr-1 -mt-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
          <Menu
            label={`Move task ${task.identifier}`}
            align="right"
            trigger={<MoreHorizontal size={15} aria-hidden="true" />}
            triggerClassName="rounded-md p-1 text-fg-subtle hover:bg-surface-tertiary hover:text-fg"
            items={moveItems}
          />
        </div>
      </div>
      <p className={`mt-1 line-clamp-2 text-sm font-medium ${task.status === 'CANCELLED' ? 'text-fg-subtle line-through' : 'text-fg'}`}>{task.title}</p>
      {task.labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.labels.slice(0, 3).map((label) => (
            <span key={label} className="rounded bg-surface-tertiary px-1.5 py-0.5 text-[10px] font-semibold text-fg-muted">
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2.5">
        <PriorityIcon priority={task.priority} />
        <DueChip task={task} />
        {task.subtaskCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-fg-subtle" title="Subtasks done">
            <CheckSquare size={12} aria-hidden="true" />
            {task.subtasksDone}/{task.subtaskCount}
            <span className="sr-only">subtasks done</span>
          </span>
        )}
        {task.commentCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-fg-subtle" title="Comments">
            <MessageSquare size={12} aria-hidden="true" />
            {task.commentCount}
            <span className="sr-only">comments</span>
          </span>
        )}
        {task.openBlockerCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger" title="Blocked by open tasks">
            <Link2 size={12} aria-hidden="true" />
            {task.openBlockerCount}
            <span className="sr-only">open blockers</span>
          </span>
        )}
        <span className="ml-auto">
          <AssigneeAvatar user={task.assignee} />
        </span>
      </div>
    </div>
  );
};

const QuickAdd = ({ status, onAdd }: { status: TaskStatus; onAdd: (status: TaskStatus, title: string) => Promise<boolean> }) => {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onAdd(status, value);
    setBusy(false);
    if (ok) setTitle('');
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-2 mb-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:bg-surface-tertiary hover:text-fg"
      >
        <Plus size={14} aria-hidden="true" /> Add task
      </button>
    );
  }
  return (
    <form
      className="mx-2 mb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        value={title}
        maxLength={200}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setTitle('');
          }
        }}
        onBlur={() => !title.trim() && setOpen(false)}
        aria-label={`New task in ${STATUS_LABELS[status]}`}
        placeholder="Task title, then Enter"
        className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-brand focus:ring-2 focus:ring-brand-muted"
      />
    </form>
  );
};
