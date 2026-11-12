import { Router } from 'express';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { invitationLookupLimiter } from '../../middleware/rateLimit.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import {
  acceptInvitationHandler,
  createInvitationHandler,
  getInvitationHandler,
  listInvitationsHandler,
} from './invitations.controller';

const router = Router();
// Batch 3/E: per-user limits (audit: invite endpoints had none).
const inviteLimiter = userRateLimit(30, 60_000, 'Too many invitation requests. Please slow down.');

// Public: InviteHandler.tsx checks a token before it knows whether the
// visitor is logged in at all.
router.get('/:token', invitationLookupLimiter, getInvitationHandler);
// Authenticated: consumes the invite for whoever is currently signed in —
// the frontend only calls this after a real session exists (see
// invitations.service.ts's acceptInvitation).
router.post('/accept/:token', ...requireSessionUser, inviteLimiter, acceptInvitationHandler);

// Authenticated: sending invites and listing the ones you've sent.
router.get('/', ...requireSessionUser, listInvitationsHandler);
router.post('/', ...requireSessionUser, inviteLimiter, createInvitationHandler);

export default router;
