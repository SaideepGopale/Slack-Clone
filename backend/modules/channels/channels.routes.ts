import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
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

router.get('/', authenticate, listChannelsHandler);
// requireWorkspaceAccess reads workspaceId from the body here (POST) —
// confirms membership before createChannel ever runs.
router.post('/', authenticate, requireWorkspaceAccess, createChannelHandler);
router.get('/admin/all', authenticate, requireAdmin, listAllChannelsAdminHandler);
router.post('/dm', authenticate, createDMHandler);
router.get('/all', authenticate, listPublicChannelsHandler);
router.delete('/:id', authenticate, requireAdmin, deleteChannelHandler);
router.post('/:id/join', authenticate, joinChannelHandler);
router.get('/:channelId/addable-members', authenticate, listAddableMembersHandler);
router.post('/:channelId/members', authenticate, addChannelMemberHandler);

export default router;
