import { NextFunction, Response, Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import * as projects from './projects.service';
import {
  announceChannelPlacement,
  announceMemberAdded,
  announceMembershipEnded,
  announceMembersUpdated,
  announceProjectCreated,
  announceProjectUpdated,
} from './projects.realtime';

/**
 * Project API (Batch 3 / Sub-batch C), mounted at /api. No
 * requireWorkspaceAccess here: lib/policy decides (organization managers may
 * manage without being workspace members; private projects answer 404).
 */
const router = Router();
const readLimiter = userRateLimit(120, 60_000, 'Too many requests. Please slow down.');
const writeLimiter = userRateLimit(30, 60_000, 'Too many project changes. Please slow down.');

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};
const read = [...requireSessionUser, readLimiter];
const write = [...requireSessionUser, writeLimiter];

// GET /api/workspaces/:workspaceId/projects?status=active|archived|all&q=&cursor=&limit=
router.get('/workspaces/:workspaceId/projects', ...read, handle(async (req, res) => {
  res.json(await projects.listProjects(req.user!.id, req.params.workspaceId, req.query));
}));

// POST /api/workspaces/:workspaceId/projects { name, description?, visibility? }
router.post('/workspaces/:workspaceId/projects', ...write, handle(async (req, res) => {
  const project = await projects.createProject(req.user!.id, req.params.workspaceId, req.body);
  await announceProjectCreated(project.id);
  res.status(201).json(project);
}));

// GET /api/projects/:projectId
router.get('/projects/:projectId', ...read, handle(async (req, res) => {
  res.json(await projects.getProject(req.user!.id, req.params.projectId));
}));

// PATCH /api/projects/:projectId { name?, description?, visibility? }
router.patch('/projects/:projectId', ...write, handle(async (req, res) => {
  const { project, previousVisibility } = await projects.updateProject(req.user!.id, req.params.projectId, req.body);
  await announceProjectUpdated(project.id, previousVisibility);
  res.json(project);
}));

// POST /api/projects/:projectId/archive | /restore
for (const [path, archived] of [['archive', true], ['restore', false]] as const) {
  router.post(`/projects/:projectId/${path}`, ...write, handle(async (req, res) => {
    const { project, changed } = await projects.setProjectArchived(req.user!.id, req.params.projectId, archived);
    if (changed) await announceProjectUpdated(project.id);
    res.json(project);
  }));
}

// POST /api/projects/:projectId/join — public projects only.
router.post('/projects/:projectId/join', ...write, handle(async (req, res) => {
  const result = await projects.joinProject(req.user!.id, req.params.projectId);
  if (result.joined && result.member) await announceMemberAdded(result.project.id, result.workspaceId, result.member);
  res.json(result.project);
}));

// POST /api/projects/:projectId/leave
router.post('/projects/:projectId/leave', ...write, handle(async (req, res) => {
  const ended = await projects.leaveProject(req.user!.id, req.params.projectId);
  await announceMembershipEnded(ended);
  res.json({ left: true, projectId: ended.projectId });
}));

// GET /api/projects/:projectId/members?q=&cursor=&limit=
router.get('/projects/:projectId/members', ...read, handle(async (req, res) => {
  res.json(await projects.listProjectMembers(req.user!.id, req.params.projectId, req.query));
}));

// POST /api/projects/:projectId/members { userId }
router.post('/projects/:projectId/members', ...write, handle(async (req, res) => {
  const { workspaceId, member } = await projects.addProjectMember(req.user!.id, req.params.projectId, req.body?.userId);
  await announceMemberAdded(req.params.projectId, workspaceId, member);
  res.status(201).json(member);
}));

// PATCH /api/projects/:projectId/members/:userId { role: 'OWNER' | 'MEMBER' } — ownership transfer.
router.patch('/projects/:projectId/members/:userId', ...write, handle(async (req, res) => {
  const result = await projects.changeProjectMemberRole(req.user!.id, req.params.projectId, req.params.userId, req.body?.role);
  await announceMembersUpdated(req.params.projectId, result.workspaceId, result.changed);
  res.json(result.member);
}));

// DELETE /api/projects/:projectId/members/:userId
router.delete('/projects/:projectId/members/:userId', ...write, handle(async (req, res) => {
  const ended = await projects.removeProjectMember(req.user!.id, req.params.projectId, req.params.userId);
  await announceMembershipEnded(ended);
  res.json({ removed: true, projectId: ended.projectId, userId: ended.userId });
}));

// GET /api/projects/:projectId/channels
router.get('/projects/:projectId/channels', ...read, handle(async (req, res) => {
  res.json(await projects.listProjectChannels(req.user!.id, req.params.projectId));
}));

// POST /api/projects/:projectId/channels { channelId } — move an existing channel into the project.
router.post('/projects/:projectId/channels', ...write, handle(async (req, res) => {
  const result = await projects.attachChannelToProject(req.user!.id, req.params.projectId, req.body?.channelId);
  await announceChannelPlacement(result, true);
  res.json({ projectId: result.projectId, channel: result.channel, moved: result.moved });
}));

// DELETE /api/projects/:projectId/channels/:channelId — move it back to workspace level.
router.delete('/projects/:projectId/channels/:channelId', ...write, handle(async (req, res) => {
  const result = await projects.detachChannelFromProject(req.user!.id, req.params.projectId, req.params.channelId);
  await announceChannelPlacement(result, false);
  res.json({ projectId: null, channel: result.channel, moved: result.moved });
}));

export default router;
