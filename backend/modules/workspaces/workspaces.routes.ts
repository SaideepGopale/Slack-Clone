import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireWorkspaceAccess } from '../../middleware/workspace.middleware';
import { listChannelsForWorkspaceHandler, listDMsForWorkspaceHandler } from '../channels/channels.controller';
import { createWorkspaceInviteHandler } from '../invitations/invitations.controller';
import { createWorkspaceHandler, deleteWorkspaceHandler, listWorkspacesHandler } from './workspaces.controller';

const router = Router();

router.get('/', authenticate, listWorkspacesHandler);
router.post('/', authenticate, createWorkspaceHandler);
// requireWorkspaceAccess reads workspaceId from req.params here — only a
// member of :workspaceId can list its channels.
router.get('/:workspaceId/channels', authenticate, requireWorkspaceAccess, listChannelsForWorkspaceHandler);
router.get('/:workspaceId/dms', authenticate, requireWorkspaceAccess, listDMsForWorkspaceHandler);
// Admin-only enforcement happens inside createInvitation itself (it checks
// WorkspaceMember.role === 'ADMIN') — no separate middleware needed here.
router.post('/:workspaceId/invites', authenticate, createWorkspaceInviteHandler);
// Owner-or-admin enforcement happens inside deleteWorkspace itself, same
// reasoning as the invite route above.
router.delete('/:workspaceId', authenticate, deleteWorkspaceHandler);

export default router;
