import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as adminService from './admin.service';
import * as messagesService from '../messages/messages.service';
import * as fileStorageService from './fileStorage.service';
import { logAuditEvent } from '../../lib/auditLog';
import { broadcastMessageDeleted } from '../../sockets/registry';

export const adminStatsHandler = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const stats = await adminService.getAdminStats();
    res.json(stats);
  } catch (err) { next(err); }
};

export const analyticsHandler = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const analytics = await adminService.getAnalytics();
    res.json(analytics);
  } catch (err) { next(err); }
};

export const exportUsersHandler = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const csv = await adminService.exportUsersCsv();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send(csv);
  } catch (err) { next(err); }
};

export const exportChannelsHandler = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const csv = await adminService.exportChannelsCsv();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="channels.csv"');
    res.send(csv);
  } catch (err) { next(err); }
};

export const auditLogsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const page = await adminService.getAuditLogs(cursor);
    res.json(page);
  } catch (err) { next(err); }
};

export const searchMessagesHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string') return res.json([]);
    const messages = await messagesService.searchMessagesGlobal(q);
    res.json(messages);
  } catch (err) { next(err); }
};

export const deleteMessageHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await messagesService.adminDeleteMessage(req.params.id);
    if (result.status === 'not_found') return res.status(404).json({ error: 'Message not found' });
    if (result.status === 'forbidden') return res.status(403).json({ error: 'Cannot delete direct-message content via this tool' });

    broadcastMessageDeleted(result.channelId, req.params.id);
    await logAuditEvent(req.user!.id, 'DELETE_MESSAGE', 'MESSAGE', req.params.id, `Deleted a message from "${result.senderUsername}": "${result.contentPreview}"`);

    res.json({ message: 'Message deleted successfully' });
  } catch (err) { next(err); }
};

export const listFilesHandler = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const files = await fileStorageService.listStoredFiles();
    res.json(files);
  } catch (err) { next(err); }
};

export const deleteFileHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await fileStorageService.deleteStoredFile(req.params.filename);
    if (result.status === 'invalid') return res.status(400).json({ error: 'Invalid filename' });
    if (result.status === 'not_found') return res.status(404).json({ error: 'File not found' });

    if (result.channelId && result.messageId) {
      broadcastMessageDeleted(result.channelId, result.messageId);
    }
    await logAuditEvent(
      req.user!.id,
      'DELETE_FILE',
      'FILE',
      req.params.filename,
      `Deleted file "${req.params.filename}"${result.messageId ? ' (and its attached message)' : ''}`
    );

    res.json({ message: 'File deleted successfully' });
  } catch (err) { next(err); }
};

export const banUserHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const user = await adminService.banUser(req.user!.id, req.params.id);
    res.json({ message: 'User banned successfully', user });
  } catch (err) { next(err); }
};

export const updateUserStatusHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body;
    const user = await adminService.updateUserStatus(req.user!.id, req.params.id, status);
    res.json({ message: `User status updated to ${user.status}`, user });
  } catch (err) { next(err); }
};

export const toggleUserRoleHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const user = await adminService.toggleUserRole(req.user!.id, req.params.id);
    res.json({ message: `User role updated to ${user.role}`, user });
  } catch (err) { next(err); }
};

export const forceResetPasswordHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await adminService.forceResetPassword(req.user!.id, req.params.id);
    res.json(result);
  } catch (err) { next(err); }
};

export const deleteUserHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await adminService.deleteUser(req.user!.id, req.params.id);
    res.json(result);
  } catch (err) { next(err); }
};
