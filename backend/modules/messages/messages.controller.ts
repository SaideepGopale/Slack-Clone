import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { ChannelScopedRequest } from '../../middleware/channelAccess.middleware';
import { broadcastReactionUpdate } from '../../sockets/registry';
import * as messagesService from './messages.service';

const REACTION_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|\p{Emoji_Presentation})+$/u;
const EMOJI_SIGNAL = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
export const isReactionEmoji = (value: string) => value.length <= 32 && REACTION_EMOJI.test(value) && EMOJI_SIGNAL.test(value);

export const getChannelMessagesHandler = async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    // T.32 (audit L9): only a positive integer page size; anything else
    // (10.5, "abc") is a 400 instead of reaching Prisma and returning 500.
    const rawLimit = req.query.limit;
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      limit = typeof rawLimit === 'string' && /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (!Number.isInteger(limit) || limit < 1) return res.status(400).json({ error: 'limit must be a positive whole number.' });
    }

    const page = await messagesService.getChannelMessages(
      req.params.id,
      cursor,
      limit,
      after,
      req.channelAccess
    );
    res.json(page);
  } catch (err) { next(err); }
};

export const searchChannelMessagesHandler = async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string') return res.json([]);
    const messages = await messagesService.searchChannelMessages(req.params.id, q, req.channelAccess);
    res.json(messages);
  } catch (err) { next(err); }
};

// GET /api/channels/:id/pinned — P2 Phase G (membership checked by the route).
export const getPinnedMessagesHandler = async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await messagesService.getPinnedMessages(req.params.id, req.channelAccess));
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
    const { emoji } = req.body ?? {};
    if (!emoji || typeof emoji !== 'string') {
      return res.status(400).json({ error: 'emoji is required' });
    }
    // T.32 (audit M13): a single emoji (incl. ZWJ sequences, skin tones,
    // flags, keycaps) — not arbitrary text that bloats the table or exceeds
    // the unique index's row size and 500s.
    if (!isReactionEmoji(emoji)) {
      return res.status(400).json({ error: 'Reactions must be a single emoji.' });
    }

    const { channelId, reactions } = await messagesService.toggleReaction(req.user!.id, req.params.messageId, emoji);
    broadcastReactionUpdate(channelId, req.params.messageId, reactions);
    res.json({ messageId: req.params.messageId, reactions });
  } catch (err) { next(err); }
};
