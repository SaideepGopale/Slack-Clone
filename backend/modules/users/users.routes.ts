import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireWorkspaceAccess } from '../../middleware/workspace.middleware';
import { listUsersHandler, updateActiveWorkspaceHandler } from './users.controller';

const router = Router();

router.get('/', authenticate, listUsersHandler);
// requireWorkspaceAccess reads workspaceId from the body here (no :id param
// on this route) — same pattern as POST /api/channels.
router.patch('/me/active-workspace', authenticate, requireWorkspaceAccess, updateActiveWorkspaceHandler);

export default router;
