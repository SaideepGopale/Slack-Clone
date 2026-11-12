import { NextFunction, Response, Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { announceTaskDeleted, announceTaskGoneFor, announceTaskUpserted, pushWorkNotifications, quietly } from './tasks.realtime';
import * as team from './teamTasks.service';
import * as tasks from './tasks.service';
import { BlockedError } from './tasks.service';
import { shareTask } from './tasks.share';

/**
 * T.33 — task API, mounted at /api. No workspace middleware: every handler
 * loads the caller's ProjectActor from the database and lib/policy decides
 * (private projects answer 404). Per-user rate limits (shared across
 * instances when Redis is configured): reads 240/min, board/task writes
 * 120/min (drag-and-drop is chatty), comments 30/min, shares 20/min.
 */
const router = Router();
const read = [...requireSessionUser, userRateLimit(240, 60_000, 'Too many requests. Please slow down.')];
const write = [...requireSessionUser, userRateLimit(120, 60_000, 'Too many task changes. Please slow down.')];
const comment = [...requireSessionUser, userRateLimit(30, 60_000, 'Too many comments. Please slow down.')];
const share = [...requireSessionUser, userRateLimit(20, 60_000, 'Too many shares. Please slow down.')];

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof BlockedError) return res.status(409).json({ error: err.message, blockers: err.blockers });
    next(err);
  }
};

// ---- tasks of a project ----
router.get('/projects/:projectId/tasks', ...read, handle(async (req, res) => {
  res.json(await tasks.listTasks(req.user!.id, req.params.projectId, req.query));
}));

router.post('/projects/:projectId/tasks', ...write, handle(async (req, res) => {
  const { task, notifications } = await tasks.createTask(req.user!.id, req.params.projectId, req.body);
  res.status(201).json({ task });
  quietly(announceTaskUpserted(task));
  if (task.parentId) quietly(tasks.getTaskView(task.parentId).then(announceTaskUpserted));
  pushWorkNotifications(notifications);
}));

router.get('/projects/:projectId/report', ...read, handle(async (req, res) => {
  res.json(await tasks.projectReport(req.user!.id, req.params.projectId));
}));

// ---- one task ----
router.get('/tasks/:taskId', ...read, handle(async (req, res) => {
  res.json(await tasks.getTask(req.user!.id, req.params.taskId));
}));

router.patch('/tasks/:taskId', ...write, handle(async (req, res) => {
  const { task, notifications, previousAssigneeId } = await tasks.updateTask(req.user!.id, req.params.taskId, req.body);
  res.json({ task });
  quietly(announceTaskUpserted(task));
  // T.38: a reassigned private assignment disappears for its previous assignee.
  if (previousAssigneeId) announceTaskGoneFor(previousAssigneeId, task.projectId, task.id);
  if (task.parentId) quietly(tasks.getTaskView(task.parentId).then(announceTaskUpserted));
  pushWorkNotifications(notifications);
}));

router.post('/tasks/:taskId/move', ...write, handle(async (req, res) => {
  const { task, notifications } = await tasks.moveTask(req.user!.id, req.params.taskId, req.body);
  res.json({ task });
  quietly(announceTaskUpserted(task));
  pushWorkNotifications(notifications);
}));

router.delete('/tasks/:taskId', ...write, handle(async (req, res) => {
  const { taskId, projectId, parentId, privateAssignment } = await tasks.deleteTask(req.user!.id, req.params.taskId);
  res.json({ deleted: true });
  quietly(announceTaskDeleted(projectId, taskId, privateAssignment));
  if (parentId) quietly(tasks.getTaskView(parentId).then(announceTaskUpserted));
}));

// ---- comments ----
router.get('/tasks/:taskId/comments', ...read, handle(async (req, res) => {
  res.json(await tasks.listComments(req.user!.id, req.params.taskId, req.query));
}));

router.post('/tasks/:taskId/comments', ...comment, handle(async (req, res) => {
  const { comment: created, task, notifications } = await tasks.addComment(req.user!.id, req.params.taskId, req.body);
  res.status(201).json({ comment: created });
  quietly(tasks.getTaskView(task.id).then(announceTaskUpserted));
  pushWorkNotifications(notifications);
}));

router.patch('/task-comments/:commentId', ...comment, handle(async (req, res) => {
  res.json({ comment: await tasks.editComment(req.user!.id, req.params.commentId, req.body) });
}));

router.delete('/task-comments/:commentId', ...write, handle(async (req, res) => {
  const { taskId } = await tasks.deleteComment(req.user!.id, req.params.commentId);
  res.json({ deleted: true });
  quietly(tasks.getTaskView(taskId).then(announceTaskUpserted));
}));

// ---- dependencies ----
router.post('/tasks/:taskId/dependencies', ...write, handle(async (req, res) => {
  const result = await tasks.addDependency(req.user!.id, req.params.taskId, req.body);
  res.status(201).json(result);
  quietly(tasks.getTaskView(req.params.taskId).then(announceTaskUpserted));
}));

router.delete('/tasks/:taskId/dependencies/:dependsOnId', ...write, handle(async (req, res) => {
  const result = await tasks.removeDependency(req.user!.id, req.params.taskId, req.params.dependsOnId);
  res.json(result);
  quietly(tasks.getTaskView(req.params.taskId).then(announceTaskUpserted));
}));

// ---- files ----
router.post('/tasks/:taskId/attachments', ...write, handle(async (req, res) => {
  res.status(201).json(await tasks.attachToTask(req.user!.id, req.params.taskId, req.body));
  quietly(tasks.getTaskView(req.params.taskId).then(announceTaskUpserted));
}));

router.delete('/tasks/:taskId/attachments/:attachmentId', ...write, handle(async (req, res) => {
  res.json(await tasks.detachFromTask(req.user!.id, req.params.taskId, req.params.attachmentId));
}));

// ---- chat integration ----
router.post('/tasks/:taskId/share', ...share, handle(async (req, res) => {
  res.json(await shareTask(req.user!.id, req.params.taskId, req.body));
}));

// ---- workspace-wide ----
// ---- T.38: the Team Lead dashboard (lead-only; private assignments) ----
router.get('/workspaces/:workspaceId/team-tasks/summary', ...read, handle(async (req, res) => {
  res.json(await team.teamSummary(req.user!.id, req.params.workspaceId));
}));

router.get('/workspaces/:workspaceId/team-tasks/options', ...read, handle(async (req, res) => {
  res.json(await team.teamTaskOptions(req.user!.id, req.params.workspaceId));
}));

router.get('/workspaces/:workspaceId/team-tasks', ...read, handle(async (req, res) => {
  res.json(await team.listTeamTasks(req.user!.id, req.params.workspaceId, req.query));
}));

router.post('/workspaces/:workspaceId/team-tasks', ...write, handle(async (req, res) => {
  const { task, notifications } = await team.createTeamTask(req.user!.id, req.params.workspaceId, req.body);
  res.status(201).json({ task });
  quietly(announceTaskUpserted(task));
  pushWorkNotifications(notifications);
}));

router.get('/workspaces/:workspaceId/my-tasks', ...read, handle(async (req, res) => {
  res.json(await tasks.myTasks(req.user!.id, req.params.workspaceId, req.query));
}));

router.get('/workspaces/:workspaceId/workload', ...read, handle(async (req, res) => {
  res.json(await tasks.workload(req.user!.id, req.params.workspaceId, req.query));
}));

router.get('/workspaces/:workspaceId/work-notifications', ...read, handle(async (req, res) => {
  res.json(await tasks.listWorkNotifications(req.user!.id, req.params.workspaceId, req.query));
}));

router.post('/work-notifications/read', ...write, handle(async (req, res) => {
  res.json(await tasks.markWorkNotificationsRead(req.user!.id, req.body));
}));

export default router;
