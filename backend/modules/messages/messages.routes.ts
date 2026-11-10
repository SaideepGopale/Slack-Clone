import { Router } from 'express';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { requireChannelMembership } from '../../middleware/channelAccess.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { getChannelMessagesHandler, getPinnedMessagesHandler, getThreadHandler, searchChannelMessagesHandler, toggleReactionHandler } from './messages.controller';

// Mounted at /api/channels alongside the channels module — messages are
// always addressed through their parent channel (GET /api/channels/:id/messages).
const router = Router();

// P3 (FA-SEC-06): in-conversation search (ILIKE over message content) is
// limited per user.
export const SEARCH_LIMIT = 60;
const searchLimiter = userRateLimit(SEARCH_LIMIT, 60_000, 'Too many searches. Please slow down.');

router.get('/:id/messages', ...requireSessionUser, requireChannelMembership, getChannelMessagesHandler);
router.get('/:id/search', ...requireSessionUser, searchLimiter, requireChannelMembership, searchChannelMessagesHandler);
router.get('/:id/pinned', ...requireSessionUser, requireChannelMembership, getPinnedMessagesHandler);

export default router;

// Mounted separately at /api/messages (see app.ts) — addressed by messageId
// directly rather than nested under a channel, so it doesn't belong on the
// channel-scoped router above. Membership is verified inside toggleReaction
// itself (it looks up the message's own channelId first), not via
// requireChannelMembership, since there's no :id channel param on this route.
export const messageActionsRouter = Router();
messageActionsRouter.get('/:messageId/thread', ...requireSessionUser, getThreadHandler);
messageActionsRouter.post('/:messageId/reactions', ...requireSessionUser, toggleReactionHandler);
