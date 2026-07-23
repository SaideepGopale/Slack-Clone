import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as invitationsService from './invitations.service';

export const listInvitationsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const invitations = await invitationsService.listInvitations(req.user!.id);
    res.json(invitations);
  } catch (err) { next(err); }
};

export const createInvitationHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { status, body } = await invitationsService.createInvitation(req.body.email, req.user!.id, req.body.workspaceId);
    res.status(status).json(body);
  } catch (err) { next(err); }
};

// REST-nested alias for POST /api/workspaces/:workspaceId/invites — identical
// logic to createInvitationHandler above (same admin check, token, email),
// just reads workspaceId from the URL param instead of the request body to
// match nesting under the /api/workspaces resource.
export const createWorkspaceInviteHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { status, body } = await invitationsService.createInvitation(req.body.email, req.user!.id, req.params.workspaceId);
    res.status(status).json(body);
  } catch (err) { next(err); }
};

// Public — no `authenticate` on this route (see invitations.routes.ts):
// InviteHandler.tsx calls this before it knows whether the visitor is logged
// in at all, to decide whether to route them to /login or /signup.
export const getInvitationHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitation = await invitationsService.getInvitationByToken(req.params.token);
    res.json(invitation);
  } catch (err) { next(err); }
};

// Authenticated — this consumes the invite for whoever is currently signed
// in (req.user.id), which is why invitations.routes.ts puts `authenticate`
// in front of it. The frontend only ever calls this after a real session
// exists (post-login or post-signup-OTP), never to create the account itself.
export const acceptInvitationHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await invitationsService.acceptInvitation(req.params.token, req.user!.id);
    res.json(result);
  } catch (err) { next(err); }
};
