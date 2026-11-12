import { NextFunction, Response, Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { announceChannelUpdated, announceMembersChanged } from './channelManagement.realtime';
import * as management from './channelManagement.service';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { requireWorkspaceAccess } from '../../middleware/workspace.middleware';
import {
  addChannelMemberHandler,
  createChannelHandler,
  createDMHandler,
  deleteChannelHandler,
  joinChannelHandler,
  listAddableMembersHandler,
  listAllChannelsAdminHandler,
  listChannelsHandler,
  listPublicChannelsHandler,
} from './channels.controller';

const router = Router();

// P3 (FA-SEC-06): creating, joining and adding people to conversations share
// one per-user budget.
export const CONVERSATION_WRITE_LIMIT = 30;
const conversationWriteLimiter = userRateLimit(CONVERSATION_WRITE_LIMIT, 60_000, 'Too many conversation changes. Please slow down.');

router.get('/', ...requireSessionUser, listChannelsHandler);
// requireWorkspaceAccess reads workspaceId from the body here (POST) —
// confirms membership before createChannel ever runs.
router.post('/', ...requireSessionUser, conversationWriteLimiter, requireWorkspaceAccess, createChannelHandler);
router.get('/admin/all', ...requireSessionUser, requireAdmin, listAllChannelsAdminHandler);
router.post('/dm', ...requireSessionUser, conversationWriteLimiter, createDMHandler);
router.get('/all', ...requireSessionUser, listPublicChannelsHandler);
router.delete('/:id', ...requireSessionUser, requireAdmin, deleteChannelHandler);
router.post('/:id/join', ...requireSessionUser, conversationWriteLimiter, joinChannelHandler);
router.get('/:channelId/addable-members', ...requireSessionUser, listAddableMembersHandler);
router.post('/:channelId/members', ...requireSessionUser, conversationWriteLimiter, addChannelMemberHandler);

// ---- Batch 3/D: channel management (lib/policy decides; no membership middleware,
// because workspace managers manage channels they don't belong to). ----
const readLimiter = userRateLimit(120, 60_000, 'Too many requests. Please slow down.');
const writeLimiter = userRateLimit(30, 60_000, 'Too many channel changes. Please slow down.');
type Handler = (req: AuthenticatedRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

// GET /api/channels/:id/details — metadata + the caller's role and capabilities.
router.get('/:id/details', ...requireSessionUser, readLimiter, handle(async (req, res) => {
  res.json(await management.getChannelDetails(req.user!.id, req.params.id));
}));

// PATCH /api/channels/:id { name?, description?, topic?, icon?, visibility?, isAnnouncement? }
router.patch('/:id', ...requireSessionUser, writeLimiter, handle(async (req, res) => {
  const result = await management.updateChannel(req.user!.id, req.params.id, req.body);
  await announceChannelUpdated(result.channel.id, result.previous.visibility, result.changed);
  res.json(result.channel);
}));

// POST /api/channels/:id/archive | /restore
for (const [path, archived] of [['archive', true], ['restore', false]] as const) {
  router.post(`/:id/${path}`, ...requireSessionUser, writeLimiter, handle(async (req, res) => {
    const { channel, changed } = await management.setChannelArchived(req.user!.id, req.params.id, archived);
    if (changed) await announceChannelUpdated(channel.id, undefined, ['archived']);
    res.json(channel);
  }));
}

// GET /api/channels/:id/members?q=&cursor=&limit=
router.get('/:id/members', ...requireSessionUser, readLimiter, handle(async (req, res) => {
  res.json(await management.listChannelMembers(req.user!.id, req.params.id, req.query));
}));

// PATCH /api/channels/:id/members/:userId { role: 'admin' | 'moderator' | 'member' } ('admin' = transfer ownership)
router.patch('/:id/members/:userId', ...requireSessionUser, writeLimiter, handle(async (req, res) => {
  const result = await management.changeChannelMemberRole(req.user!.id, req.params.id, req.params.userId, req.body?.role);
  await announceMembersChanged(req.params.id, result.changed.map((member) => ({ change: 'role' as const, member })));
  res.json(result.member);
}));

export default router;
