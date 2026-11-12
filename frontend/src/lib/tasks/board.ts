import { TASK_PRIORITIES, TASK_STATUSES, TaskPriority, TaskStatus, TaskView } from '../api/tasks';

/** T.33 — pure helpers behind the board, list and calendar views. */

const byPosition = (a: TaskView, b: TaskView) => a.position - b.position || a.number - b.number;

export const groupByStatus = (tasks: TaskView[]): Record<TaskStatus, TaskView[]> => {
  const columns = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as TaskView[]])) as Record<TaskStatus, TaskView[]>;
  for (const t of tasks) columns[t.status]?.push(t);
  for (const s of TASK_STATUSES) columns[s].sort(byPosition);
  return columns;
};

/**
 * Optimistic move: puts `taskId` at `index` of the `status` column and gives
 * it a position between its new neighbours. Returns the neighbour ids the
 * server needs (prev = card above, next = card below).
 */
export const applyMove = (tasks: TaskView[], taskId: string, status: TaskStatus, index: number) => {
  const moving = tasks.find((t) => t.id === taskId);
  if (!moving) return { tasks, prevId: null, nextId: null, changed: false };
  const column = groupByStatus(tasks)[status].filter((t) => t.id !== taskId);
  const at = Math.max(0, Math.min(index, column.length));
  const prev = column[at - 1] ?? null;
  const next = column[at] ?? null;

  const original = groupByStatus(tasks)[moving.status];
  const unchanged = moving.status === status && original.indexOf(moving) === at;
  if (unchanged) return { tasks, prevId: prev?.id ?? null, nextId: next?.id ?? null, changed: false };

  let position: number;
  if (prev && next) position = (prev.position + next.position) / 2;
  else if (prev) position = prev.position + 1;
  else if (next) position = next.position - 1;
  else position = 1;

  return {
    tasks: tasks.map((t) => (t.id === taskId ? { ...t, status, position } : t)),
    prevId: prev?.id ?? null,
    nextId: next?.id ?? null,
    changed: true,
  };
};

export const upsertTask = (tasks: TaskView[], task: TaskView) =>
  tasks.some((t) => t.id === task.id) ? tasks.map((t) => (t.id === task.id ? task : t)) : [...tasks, task];

export const removeTask = (tasks: TaskView[], taskId: string) => tasks.filter((t) => t.id !== taskId);

export interface BoardFilters {
  q?: string;
  assigneeId?: string; // '' | 'me' | 'none' | id
  priority?: TaskPriority[];
  label?: string;
}

export const filterTasks = (tasks: TaskView[], filters: BoardFilters, myId: string | undefined) => {
  const q = filters.q?.trim().toLowerCase();
  const label = filters.label?.trim().toLowerCase();
  return tasks.filter((t) => {
    if (q && !t.title.toLowerCase().includes(q) && !t.identifier.toLowerCase().includes(q)) return false;
    if (filters.assigneeId === 'me' && t.assignee?.id !== myId) return false;
    if (filters.assigneeId === 'none' && t.assignee) return false;
    if (filters.assigneeId && !['me', 'none'].includes(filters.assigneeId) && t.assignee?.id !== filters.assigneeId) return false;
    if (filters.priority?.length && !filters.priority.includes(t.priority)) return false;
    if (label && !t.labels.some((l) => l.toLowerCase() === label)) return false;
    return true;
  });
};

export type SortKey = 'identifier' | 'title' | 'status' | 'priority' | 'assignee' | 'dueDate';

export const sortTasks = (tasks: TaskView[], key: SortKey, dir: 'asc' | 'desc') => {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (t: TaskView): string | number => {
    switch (key) {
      case 'identifier':
        return t.number;
      case 'title':
        return t.title.toLowerCase();
      case 'status':
        return TASK_STATUSES.indexOf(t.status);
      case 'priority':
        return TASK_PRIORITIES.indexOf(t.priority);
      case 'assignee':
        return (t.assignee?.displayName || t.assignee?.username || '￿').toLowerCase();
      case 'dueDate':
        return t.dueDate ?? '';
    }
  };
  return [...tasks].sort((a, b) => {
    if (key === 'dueDate' && (!a.dueDate || !b.dueDate)) return a.dueDate ? -1 : b.dueDate ? 1 : 0;
    const va = value(a);
    const vb = value(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * sign || a.number - b.number;
  });
};

// Dates are calendar days: a due date is stored at the end of that day (UTC)
// and always shown from its date part, so it never shifts with time zones.
export const dateOnly = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
export const toDueIso = (day: string) => (day ? `${day}T23:59:59.999Z` : null);
export const toStartIso = (day: string) => (day ? `${day}T00:00:00.000Z` : null);

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = () => dayKey(new Date());

/** Whole Monday-first weeks covering `month` (0-based) of `year`, as YYYY-MM-DD keys. */
export const monthGrid = (year: number, month: number): string[][] => {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  const last = new Date(year, month + 1, 0);
  const end = new Date(year, month + 1, 0 + ((7 - ((last.getDay() + 6) % 7) - 1) % 7));
  const weeks: string[][] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(dayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
};
