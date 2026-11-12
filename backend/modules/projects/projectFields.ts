import { Prisma, ProjectStatus } from '@prisma/client';
import { HttpError } from '../../lib/httpError';

/**
 * T.33 — project lifecycle and task settings, shared by create and update:
 * status (Planning / Active / On hold / Completed; "Archived" stays the
 * separate archive action), a short key for task identifiers, the review
 * rule and the planned dates.
 */
const STATUSES: ProjectStatus[] = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED'];

const parseDate = (value: unknown, label: string): Date | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 40) throw new HttpError(400, `${label} must be a date.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) throw new HttpError(400, `${label} must be a valid date.`);
  return date;
};

export const parseProjectWorkFields = (
  body: Record<string, unknown> | undefined,
  current: { startDate: Date | null; dueDate: Date | null } = { startDate: null, dueDate: null }
): Pick<Prisma.ProjectUncheckedUpdateInput, 'status' | 'key' | 'requireReview' | 'startDate' | 'dueDate'> => {
  const data: Pick<Prisma.ProjectUncheckedUpdateInput, 'status' | 'key' | 'requireReview' | 'startDate' | 'dueDate'> = {};
  if (!body) return data;
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !STATUSES.includes(body.status as ProjectStatus)) {
      throw new HttpError(400, 'status must be PLANNING, ACTIVE, ON_HOLD or COMPLETED.');
    }
    data.status = body.status as ProjectStatus;
  }
  if (body.key !== undefined) {
    if (body.key === null || body.key === '') data.key = null;
    else {
      const key = typeof body.key === 'string' ? body.key.trim().toUpperCase() : '';
      if (!/^[A-Z][A-Z0-9]{1,5}$/.test(key)) throw new HttpError(400, 'The project key must be 2–6 letters or digits, starting with a letter.');
      data.key = key;
    }
  }
  if (body.requireReview !== undefined) {
    if (typeof body.requireReview !== 'boolean') throw new HttpError(400, 'requireReview must be true or false.');
    data.requireReview = body.requireReview;
  }
  const startDate = body.startDate !== undefined ? parseDate(body.startDate, 'The start date') : current.startDate;
  const dueDate = body.dueDate !== undefined ? parseDate(body.dueDate, 'The due date') : current.dueDate;
  if (startDate && dueDate && dueDate < startDate) throw new HttpError(400, 'The due date cannot be before the start date.');
  if (body.startDate !== undefined) data.startDate = startDate;
  if (body.dueDate !== undefined) data.dueDate = dueDate;
  return data;
};
