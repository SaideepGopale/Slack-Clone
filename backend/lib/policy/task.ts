import { HttpError } from '../httpError';
import { canManageWorkspace, canProject, effectiveProjectRole, PROJECT_ARCHIVED_MESSAGE, ProjectActor } from './policy';

/**
 * T.33 — task permissions, layered on the project policy (a task is only
 * reachable through a project the caller can view).
 *
 *  - Project lead = project OWNER, or a workspace/organization owner or
 *    admin (canManageWorkspace). Leads manage every task of the project.
 *  - Project members create tasks, comment, and work on tasks they created
 *    or are assigned to. They may assign tasks to themselves, never to others.
 *  - Status changes: the lead or the assignee (the creator too while the
 *    task is unassigned). With `requireReview`, only a lead marks it Done.
 *  - Deleting: the lead or the creator.
 *  - Archived project: everything is read-only.
 */
export interface TaskSubject {
  creatorId: string | null;
  assigneeId: string | null;
  /** T.38: a private assignment (see canPrivateTask). */
  assigneeOnly?: boolean;
}

export type TaskAction = 'task.view' | 'task.create' | 'task.comment' | 'task.update' | 'task.changeStatus' | 'task.complete' | 'task.assignOthers' | 'task.assignSelf' | 'task.delete';

export const isProjectLead = (actor: ProjectActor) => effectiveProjectRole(actor) === 'OWNER' || canManageWorkspace(actor.workspace);
const isProjectMember = (actor: ProjectActor) => effectiveProjectRole(actor) !== null;

/**
 * T.38 — a private assignment (created from the Team Lead dashboard) is
 * visible only to its assignee, its creator and the project's leads (who must
 * be members of the workspace: organization managers without workspace
 * membership have no content access). Project membership is NOT required of
 * the assignee — the task itself grants access to exactly that person.
 *  - assignee: view, comment, change status / complete (never cancel: see
 *    tasks.service), nothing else;
 *  - creator (no longer a lead): view and comment;
 *  - leads: everything.
 */
const canPrivateTask = (actor: ProjectActor, action: TaskAction, task: TaskSubject, options: { requireReview?: boolean }): boolean => {
  const inWorkspace = actor.workspace.workspaceRole !== null;
  const lead = inWorkspace && canProject(actor, 'project.view') && isProjectLead(actor);
  const assignee = inWorkspace && task.assigneeId === actor.userId;
  const creator = inWorkspace && task.creatorId === actor.userId;
  if (action === 'task.view') return lead || assignee || creator;
  if (actor.archived) return false;
  switch (action) {
    case 'task.comment':
      return lead || assignee || creator;
    case 'task.changeStatus':
      return lead || assignee;
    case 'task.complete':
      return options.requireReview ? lead : lead || assignee;
    default:
      // create, update, assignOthers, assignSelf, delete
      return lead;
  }
};

export const canTask = (actor: ProjectActor, action: TaskAction, task?: TaskSubject, options: { requireReview?: boolean } = {}): boolean => {
  if (task?.assigneeOnly) return canPrivateTask(actor, action, task, options);
  if (!canProject(actor, 'project.view')) return false;
  if (action === 'task.view') return true;
  if (actor.archived) return false;
  const lead = isProjectLead(actor);
  const member = isProjectMember(actor);
  const me = actor.userId;
  const assignee = !!task && task.assigneeId === me;
  const creator = !!task && task.creatorId === me;
  switch (action) {
    case 'task.create':
    case 'task.comment':
      return lead || member;
    // A creator/assignee acts only while still a project member.
    case 'task.update':
      return lead || (member && (creator || assignee));
    case 'task.changeStatus':
      return lead || (member && (assignee || (creator && !task?.assigneeId)));
    case 'task.complete':
      return options.requireReview ? lead : canTask(actor, 'task.changeStatus', task, options);
    case 'task.assignOthers':
      return lead;
    case 'task.assignSelf':
      // Take an unassigned task, or hand back your own.
      return lead || (member && (!task || !task.assigneeId || assignee));
    case 'task.delete':
      return lead || (member && creator);
    default:
      return false;
  }
};

const TASK_DENIALS: Record<TaskAction, string> = {
  'task.view': 'Task not found.',
  'task.create': 'Only project members can add tasks to this project.',
  'task.comment': 'Only project members can comment on tasks.',
  'task.update': 'Only the project lead, the task creator or its assignee can change this task.',
  'task.changeStatus': 'Only the project lead or the assignee can change the status of this task.',
  'task.complete': 'This project requires review: only a project lead can mark tasks as done.',
  'task.assignOthers': 'Only a project lead can assign tasks to other people.',
  'task.assignSelf': 'This task is already assigned to someone else.',
  'task.delete': 'Only the project lead or the task creator can delete this task.',
};

/** 404 when the project is invisible, 409 when only the archive blocks it, 403 otherwise. */
export const assertTask = (actor: ProjectActor, action: TaskAction, task?: TaskSubject, options: { requireReview?: boolean } = {}) => {
  if (canTask(actor, action, task, options)) return;
  // Whoever may not even see the task (T.38: incl. someone else's private assignment) gets "not found".
  if (!canTask(actor, 'task.view', task, options)) throw new HttpError(404, 'Task not found.');
  if (actor.archived && canTask({ ...actor, archived: false }, action, task, options)) throw new HttpError(409, PROJECT_ARCHIVED_MESSAGE);
  throw new HttpError(403, TASK_DENIALS[action]);
};

/** The capability flags the client renders controls from. */
export const taskCapabilities = (actor: ProjectActor, task: TaskSubject, requireReview: boolean) => ({
  update: canTask(actor, 'task.update', task),
  changeStatus: canTask(actor, 'task.changeStatus', task),
  complete: canTask(actor, 'task.complete', task, { requireReview }),
  assignOthers: canTask(actor, 'task.assignOthers', task),
  assignSelf: canTask(actor, 'task.assignSelf', task),
  delete: canTask(actor, 'task.delete', task),
  comment: canTask(actor, 'task.comment', task),
});
