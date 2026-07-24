import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import {
  acceptInvitationHandler,
  createInvitationHandler,
  getInvitationHandler,
  listInvitationsHandler,
} from './invitations.controller';

const router = Router();

// Public: InviteHandler.tsx checks a token before it knows whether the
// visitor is logged in at all.
router.get('/:token', getInvitationHandler);
// Authenticated: consumes the invite for whoever is currently signed in —
// the frontend only calls this after a real session exists (see
// invitations.service.ts's acceptInvitation).
router.post('/accept/:token', authenticate, acceptInvitationHandler);

// Authenticated: sending invites and listing the ones you've sent.
router.get('/', authenticate, listInvitationsHandler);
router.post('/', authenticate, createInvitationHandler);

export default router;
