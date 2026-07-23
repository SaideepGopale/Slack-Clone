import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireChannelMembership } from '../../middleware/channelAccess.middleware';
import { getChannelMessagesHandler, getThreadHandler, searchChannelMessagesHandler, toggleReactionHandler } from './messages.controller';

// Mounted at /api/channels alongside the channels module — messages are
// always addressed through their parent channel (GET /api/channels/:id/messages).
const router = Router();

router.get('/:id/messages', authenticate, requireChannelMembership, getChannelMessagesHandler);
router.get('/:id/search', authenticate, requireChannelMembership, searchChannelMessagesHandler);

export default router;

// Mounted separately at /api/messages (see app.ts) — addressed by messageId
// directly rather than nested under a channel, so it doesn't belong on the
// channel-scoped router above. Membership is verified inside toggleReaction
// itself (it looks up the message's own channelId first), not via
// requireChannelMembership, since there's no :id channel param on this route.
export const messageActionsRouter = Router();
messageActionsRouter.get('/:messageId/thread', authenticate, getThreadHandler);
messageActionsRouter.post('/:messageId/reactions', authenticate, toggleReactionHandler);
