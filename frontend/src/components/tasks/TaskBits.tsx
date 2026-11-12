import { format, parseISO } from 'date-fns';
import { AlertTriangle, ArrowDown, ArrowUp, CalendarDays, ChevronsUp, Minus } from 'lucide-react';
import { PRIORITY_LABELS, STATUS_LABELS, TaskPriority, TaskStatus, TaskView, personName, UserRef } from '../../lib/api/tasks';
import { dateOnly } from '../../lib/tasks/board';
import { Avatar } from '../ui/Avatar';

/** T.33 — small, shared task presentation pieces (status, priority, due, assignee). */

const STATUS_STYLES: Record<TaskStatus, string> = {
  BACKLOG: 'bg-surface-tertiary text-fg-muted',
  TODO: 'bg-info-soft text-info',
  IN_PROGRESS: 'bg-brand-soft text-brand',
  IN_REVIEW: 'bg-warning-soft text-warning',
  BLOCKED: 'bg-danger-soft text-danger',
  DONE: 'bg-success-soft text-success',
  CANCELLED: 'bg-surface-tertiary text-fg-subtle line-through',
};

export const STATUS_DOT: Record<TaskStatus, string> = {
  BACKLOG: 'bg-fg-subtle',
  TODO: 'bg-info',
  IN_PROGRESS: 'bg-brand',
  IN_REVIEW: 'bg-warning',
  BLOCKED: 'bg-danger',
  DONE: 'bg-success',
  CANCELLED: 'bg-fg-subtle',
};

export const StatusBadge = ({ status }: { status: TaskStatus }) => (
  <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[status]}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
    {STATUS_LABELS[status]}
  </span>
);

const PRIORITY_ICON: Record<TaskPriority, { icon: typeof ArrowUp; className: string }> = {
  URGENT: { icon: ChevronsUp, className: 'text-danger' },
  HIGH: { icon: ArrowUp, className: 'text-warning' },
  MEDIUM: { icon: Minus, className: 'text-info' },
  LOW: { icon: ArrowDown, className: 'text-fg-subtle' },
};

export const PriorityIcon = ({ priority, withLabel = false }: { priority: TaskPriority; withLabel?: boolean }) => {
  const { icon: Icon, className } = PRIORITY_ICON[priority];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-semibold text-fg-muted" title={`${PRIORITY_LABELS[priority]} priority`}>
      <Icon size={13} className={className} aria-hidden="true" />
      {withLabel ? PRIORITY_LABELS[priority] : <span className="sr-only">{PRIORITY_LABELS[priority]} priority</span>}
    </span>
  );
};

export const formatDay = (iso: string | null | undefined, pattern = 'MMM d') => {
  const day = dateOnly(iso);
  return day ? format(parseISO(day), pattern) : '';
};

export const DueChip = ({ task }: { task: Pick<TaskView, 'dueDate' | 'overdue' | 'status'> }) => {
  if (!task.dueDate) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium ${task.overdue ? 'text-danger' : 'text-fg-subtle'}`}
      title={task.overdue ? 'Overdue' : 'Due date'}
    >
      {task.overdue ? <AlertTriangle size={12} aria-hidden="true" /> : <CalendarDays size={12} aria-hidden="true" />}
      {formatDay(task.dueDate)}
      {task.overdue && <span className="sr-only">(overdue)</span>}
    </span>
  );
};

export const AssigneeAvatar = ({ user, size = 'xs' }: { user: UserRef | null; size?: 'xs' | 'sm' }) =>
  user ? (
    <span title={`Assigned to ${personName(user)}`} className="inline-flex">
      <Avatar name={personName(user)} size={size} />
      <span className="sr-only">Assigned to {personName(user)}</span>
    </span>
  ) : (
    <span
      title="Unassigned"
      className={`inline-flex items-center justify-center rounded-md border border-dashed border-border-strong text-fg-subtle ${size === 'xs' ? 'h-5 w-5' : 'h-7 w-7'}`}
    >
      <span className="sr-only">Unassigned</span>
    </span>
  );

/** Native select styled like the other controls. */
export const selectClass =
  'h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-fg outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand-muted disabled:bg-surface-secondary disabled:text-fg-subtle';
