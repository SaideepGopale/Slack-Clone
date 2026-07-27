import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import {
  adminStatsHandler,
  analyticsHandler,
  auditLogsHandler,
  banUserHandler,
  broadcastMessageHandler,
  deleteFileHandler,
  deleteMessageHandler,
  deleteUserHandler,
  exportChannelsHandler,
  exportUsersHandler,
  forceResetPasswordHandler,
  listFilesHandler,
  searchMessagesHandler,
  toggleUserRoleHandler,
  updateUserStatusHandler,
} from './admin.controller';

// The old hardcoded-credential POST /login here has been removed — admin
// panel access now goes through the standard /api/auth/login, whose JWT
// carries the user's real `role`. Every route below is admin-only.
const router = Router();

router.use(authenticate, requireAdmin);

router.get('/stats', adminStatsHandler);
router.get('/analytics', analyticsHandler);
router.get('/audit-logs', auditLogsHandler);
router.get('/export/users', exportUsersHandler);
router.get('/export/channels', exportChannelsHandler);
router.get('/messages/search', searchMessagesHandler);
router.delete('/messages/:id', deleteMessageHandler);
router.get('/files', listFilesHandler);
router.delete('/files/:publicId', deleteFileHandler);
router.post('/users/:id/ban', banUserHandler);
router.patch('/users/:id/status', updateUserStatusHandler);
router.patch('/users/:id/role', toggleUserRoleHandler);
router.post('/users/:id/force-reset', forceResetPasswordHandler);
router.delete('/users/:id', deleteUserHandler);
router.post('/broadcast', broadcastMessageHandler);

export default router;
