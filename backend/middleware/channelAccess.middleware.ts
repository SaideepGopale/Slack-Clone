import { Response, NextFunction } from 'express';
import { ChannelAccess, getChannelAccess } from '../sockets/channelAccess';
import { AuthenticatedRequest } from './auth.middleware';

export interface ChannelScopedRequest extends AuthenticatedRequest {
  channelAccess?: ChannelAccess;
}

/**
 * REST-side channel authorization, shared with the socket layer
 * (sockets/channelAccess.ts#getChannelAccess): the caller must be a member of
 * the channel AND of the workspace that owns it, checked against the database
 * on every request. That is what makes removal from a workspace/channel/group
 * DM take effect on the very next API call — no token change required.
 *
 * Attaches `req.channelAccess` (incl. the member's visible-history window) for
 * handlers that filter messages. Fails closed on unexpected errors instead of
 * leaving the request hanging (Express 4 does not catch async rejections).
 */
export const requireChannelMembership = async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
  try {
    const channelId = req.params.id ?? req.params.channelId;
    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }

    const access = await getChannelAccess(req.user!.id, channelId);
    if (!access) {
      return res.status(403).json({ error: 'You are not a member of this channel.' });
    }

    req.channelAccess = access;
    next();
  } catch (err) {
    next(err);
  }
};
