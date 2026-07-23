import { Response, NextFunction } from 'express';
import { isChannelMember } from '../sockets/channelAccess';
import { AuthenticatedRequest } from './auth.middleware';

// REST-side equivalent of the Socket.IO join-time check in
// sockets/channelAccess.ts — reuses the exact same ChannelMember lookup.
//
// SECURITY FIX: GET /:id/messages and /:id/search previously had no
// membership check at all — any authenticated user could read any
// channel's message history (including channels in workspaces they don't
// belong to) just by knowing its id.
export const requireChannelMembership = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const channelId = req.params.id;
  if (!channelId) {
    return res.status(400).json({ error: 'channelId is required' });
  }

  const isMember = await isChannelMember(req.user!.id, channelId);
  if (!isMember) {
    return res.status(403).json({ error: 'You are not a member of this channel.' });
  }

  next();
};
