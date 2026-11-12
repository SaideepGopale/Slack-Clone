import { prisma } from '../../lib/prisma';
import { CLOSED_STATUSES } from './tasks.views';

export interface TaskCounts {
  total: number;
  open: number;
  done: number;
  overdue: number;
}

/** T.33: task counts for a page of projects (two grouped queries, whatever the page size). */
export const taskCountsByProject = async (projectIds: string[]): Promise<Map<string, TaskCounts>> => {
  const out = new Map<string, TaskCounts>();
  if (projectIds.length === 0) return out;
  for (const id of projectIds) out.set(id, { total: 0, open: 0, done: 0, overdue: 0 });
  const [grouped, overdue] = await Promise.all([
    prisma.task.groupBy({ by: ['projectId', 'status'], where: { projectId: { in: projectIds } }, _count: { _all: true } }),
    prisma.task.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, status: { notIn: CLOSED_STATUSES }, dueDate: { lt: new Date() } },
      _count: { _all: true },
    }),
  ]);
  for (const g of grouped) {
    const c = out.get(g.projectId)!;
    c.total += g._count._all;
    if (g.status === 'DONE') c.done += g._count._all;
    else if (g.status !== 'CANCELLED') c.open += g._count._all;
  }
  for (const g of overdue) out.get(g.projectId)!.overdue = g._count._all;
  return out;
};
