import { Router } from 'express';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { requireWorkspaceAccess } from '../../middleware/workspace.middleware';
import { getMyProfileHandler, listUsersHandler, updateActiveWorkspaceHandler, updateMyProfileHandler } from './users.controller';

const router = Router();
const profileWriteLimiter = userRateLimit(30, 60_000, 'Too many profile updates. Please slow down.');

router.get('/', ...requireSessionUser, listUsersHandler);
// requireWorkspaceAccess reads workspaceId from the body here (no :id param
// on this route) — same pattern as POST /api/channels.
router.patch('/me/active-workspace', ...requireSessionUser, requireWorkspaceAccess, updateActiveWorkspaceHandler);
router.get('/me/profile', ...requireSessionUser, getMyProfileHandler);
router.patch('/me/profile', ...requireSessionUser, profileWriteLimiter, updateMyProfileHandler);

export default router;
