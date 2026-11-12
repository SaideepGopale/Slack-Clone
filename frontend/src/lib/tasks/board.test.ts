import { describe, expect, it } from 'vitest';
import type { TaskView } from '../api/tasks';
import { applyMove, dateOnly, filterTasks, groupByStatus, monthGrid, removeTask, sortTasks, toDueIso, toStartIso, upsertTask } from './board';

const task = (id: string, status: TaskView['status'], position: number, extra: Partial<TaskView> = {}): TaskView => ({
  id,
  projectId: 'p1',
  workspaceId: 'ws',
  number: Number(id.replace(/\D/g, '')) || 1,
  identifier: `WEB-${id}`,
  title: `Task ${id}`,
  description: null,
  status,
  priority: 'MEDIUM',
  assignee: null,
  creator: null,
  parentId: null,
  startDate: null,
  dueDate: null,
  estimateHours: null,
  actualHours: null,
  labels: [],
  position,
  completedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  subtaskCount: 0,
  subtasksDone: 0,
  commentCount: 0,
  openBlockerCount: 0,
  overdue: false,
  ...extra,
});

describe('board helpers (T.33)', () => {
  const tasks = [task('1', 'TODO', 2), task('2', 'TODO', 1), task('3', 'IN_PROGRESS', 1), task('4', 'TODO', 3)];

  it('groups by status in column order, each column by position', () => {
    const columns = groupByStatus(tasks);
    expect(Object.keys(columns)).toEqual(['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELLED']);
    expect(columns.TODO.map((t) => t.id)).toEqual(['2', '1', '4']);
    expect(columns.IN_PROGRESS.map((t) => t.id)).toEqual(['3']);
  });

  it('moving computes the new neighbours and an in-between position', () => {
    // Into IN_PROGRESS above task 3.
    const a = applyMove(tasks, '1', 'IN_PROGRESS', 0);
    expect(a).toMatchObject({ prevId: null, nextId: '3' });
    const moved = a.tasks.find((t) => t.id === '1')!;
    expect(moved.status).toBe('IN_PROGRESS');
    expect(moved.position).toBeLessThan(1);

    // Within TODO: task 2 (first) to the end.
    const b = applyMove(tasks, '2', 'TODO', 2);
    expect(b).toMatchObject({ prevId: '4', nextId: null });
    expect(groupByStatus(b.tasks).TODO.map((t) => t.id)).toEqual(['1', '4', '2']);

    // Between two cards.
    const c = applyMove(tasks, '4', 'TODO', 1);
    expect(c).toMatchObject({ prevId: '2', nextId: '1' });
    const p = c.tasks.find((t) => t.id === '4')!.position;
    expect(p).toBeGreaterThan(1);
    expect(p).toBeLessThan(2);

    // Empty column.
    expect(applyMove(tasks, '3', 'DONE', 0)).toMatchObject({ prevId: null, nextId: null });
  });

  it('a no-op move reports unchanged', () => {
    expect(applyMove(tasks, '2', 'TODO', 0).changed).toBe(false);
    expect(applyMove(tasks, '2', 'TODO', 1).changed).toBe(true);
  });

  it('upserts and removes tasks immutably', () => {
    const updated = upsertTask(tasks, { ...tasks[0], title: 'Renamed' });
    expect(updated).not.toBe(tasks);
    expect(updated.find((t) => t.id === '1')!.title).toBe('Renamed');
    expect(upsertTask(tasks, task('9', 'BACKLOG', 1))).toHaveLength(5);
    expect(removeTask(tasks, '1').map((t) => t.id)).toEqual(['2', '3', '4']);
  });

  it('filters by search, assignee (me/none/id), priority and label', () => {
    const me = { id: 'me', username: 'ann', displayName: null };
    const list = [
      task('1', 'TODO', 1, { title: 'Fix login', assignee: me, priority: 'HIGH', labels: ['auth'] }),
      task('2', 'TODO', 2, { title: 'Write docs' }),
    ];
    expect(filterTasks(list, { q: 'login' }, 'me').map((t) => t.id)).toEqual(['1']);
    expect(filterTasks(list, { q: 'web-2' }, 'me').map((t) => t.id)).toEqual(['2']);
    expect(filterTasks(list, { assigneeId: 'me' }, 'me').map((t) => t.id)).toEqual(['1']);
    expect(filterTasks(list, { assigneeId: 'none' }, 'me').map((t) => t.id)).toEqual(['2']);
    expect(filterTasks(list, { priority: ['HIGH'] }, 'me').map((t) => t.id)).toEqual(['1']);
    expect(filterTasks(list, { label: 'auth' }, 'me').map((t) => t.id)).toEqual(['1']);
  });

  it('sorts for the list view', () => {
    const list = [task('1', 'DONE', 1, { priority: 'LOW', dueDate: '2026-12-01T23:59:59.999Z' }), task('2', 'TODO', 1, { priority: 'URGENT' })];
    expect(sortTasks(list, 'priority', 'asc').map((t) => t.id)).toEqual(['2', '1']);
    expect(sortTasks(list, 'status', 'asc').map((t) => t.id)).toEqual(['2', '1']);
    // Undated tasks sort last regardless of direction.
    expect(sortTasks(list, 'dueDate', 'asc').map((t) => t.id)).toEqual(['1', '2']);
    expect(sortTasks(list, 'dueDate', 'desc').map((t) => t.id)).toEqual(['1', '2']);
  });

  it('keeps calendar days stable across time zones', () => {
    expect(toDueIso('2026-11-20')).toBe('2026-11-20T23:59:59.999Z');
    expect(toStartIso('2026-11-20')).toBe('2026-11-20T00:00:00.000Z');
    expect(dateOnly('2026-11-20T23:59:59.999Z')).toBe('2026-11-20');
    expect(toDueIso('')).toBeNull();
    expect(dateOnly(null)).toBe('');
  });

  it('builds a Monday-first month grid of whole weeks', () => {
    const weeks = monthGrid(2026, 10); // November 2026 (month index 10)
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0]).toBe('2026-10-26'); // Monday before Sun 1 Nov
    expect(weeks.flat()).toContain('2026-11-30');
    expect(weeks.flat().at(-1)).toBe('2026-12-06');
  });
});
