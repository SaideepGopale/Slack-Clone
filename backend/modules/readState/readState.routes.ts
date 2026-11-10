import { NextFunction, Response, Router } from 'express';
import { ChannelScopedRequest, requireChannelMembership } from '../../middleware/channelAccess.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { requireWorkspaceAccess, WorkspaceScopedRequest } from '../../middleware/workspace.middleware';
import { notifyUser } from '../../sockets/registry';
import * as readStateService from './readState.service';

const router = Router();
const readLimiter = userRateLimit(240, 60_000, 'Too many read updates. Please slow down.');

// GET /api/workspaces/:workspaceId/unread — persisted read state for every
// conversation the caller belongs to in the workspace (reload/device safe).
router.get(
  '/workspaces/:workspaceId/unread',
  ...requireSessionUser,
  requireWorkspaceAccess,
  async (req: WorkspaceScopedRequest, res: Response, next: NextFunction) => {
    try {
      const channels = await readStateService.getWorkspaceReadState(req.user!.id, req.params.workspaceId);
      res.json({ channels, cap: readStateService.UNREAD_CAP });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/channels/:id/read { messageId? } — advance the caller's read
// position (monotonic). Every tab/device of the caller is told the new
// authoritative state; DM participants who share receipts get a receipt.
router.post(
  '/channels/:id/read',
  ...requireSessionUser,
  readLimiter,
  requireChannelMembership,
  async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
    try {
      const access = req.channelAccess!;
      const { state, advanced } = await readStateService.markRead(req.user!.id, access, req.body?.messageId);
      if (advanced) {
        notifyUser(req.user!.id, 'read:updated', state);
        const recipients = await readStateService.receiptRecipients(req.user!.id, access, state);
        for (const { userId, receipt } of recipients) {
          notifyUser(userId, 'receipt:updated', { channelId: access.channelId, ...receipt });
        }
      }
      res.json({ ...state, advanced });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/channels/:id/read-receipts — DM/group-DM participants only.
router.get(
  '/channels/:id/read-receipts',
  ...requireSessionUser,
  requireChannelMembership,
  async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await readStateService.getReadReceipts(req.user!.id, req.channelAccess!));
    } catch (err) {
      next(err);
    }
  }
);

export default router;
