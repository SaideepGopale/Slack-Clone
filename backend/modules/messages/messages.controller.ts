import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { broadcastReactionUpdate } from '../../sockets/registry';
import * as messagesService from './messages.service';

export const getChannelMessagesHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const page = await messagesService.getChannelMessages(
      req.params.id,
      cursor,
      Number.isFinite(limit) ? limit : undefined
    );
    res.json(page);
  } catch (err) { next(err); }
};

export const searchChannelMessagesHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const messages = await messagesService.searchChannelMessages(req.params.id, q as string);
    res.json(messages);
  } catch (err) { next(err); }
};

// GET /api/messages/:messageId/thread — the parent message plus its full
// list of replies, fetched only when a thread panel is actually opened.
export const getThreadHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const thread = await messagesService.getThread(req.user!.id, req.params.messageId);
    res.json(thread);
  } catch (err) { next(err); }
};

// POST /api/messages/:messageId/reactions — creates/removes the caller's own
// reaction (toggle), then broadcasts the message's full updated reaction list
// to everyone in its channel via the same socket event the live UI already
// listens for, so the REST caller's own other tabs/sessions update too.
export const toggleReactionHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { emoji } = req.body;
    if (!emoji || typeof emoji !== 'string') {
      return res.status(400).json({ error: 'emoji is required' });
    }

    const { channelId, reactions } = await messagesService.toggleReaction(req.user!.id, req.params.messageId, emoji);
    broadcastReactionUpdate(channelId, req.params.messageId, reactions);
    res.json({ messageId: req.params.messageId, reactions });
  } catch (err) { next(err); }
};
