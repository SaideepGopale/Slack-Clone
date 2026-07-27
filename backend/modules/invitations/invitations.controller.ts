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

// GET /api/workspaces/:workspaceId/invite-link — admin-only (enforced inside
// getWorkspaceInviteLink itself, same pattern as createWorkspaceInviteHandler
// above).
export const getWorkspaceInviteLinkHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await invitationsService.getWorkspaceInviteLink(req.user!.id, req.params.workspaceId);
    res.json(result);
  } catch (err) { next(err); }
};

// POST /api/workspaces/join — files a join request for whoever is currently
// signed in, same trust model as acceptInvitationHandler above. Returns
// status: 'pending' (needs admin approval) or 'already_member' (lets the
// frontend redirect straight in, same as before this flow required approval).
export const joinWorkspaceHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await invitationsService.requestToJoinWorkspace(req.user!.id, req.body.token);
    res.json(result);
  } catch (err) { next(err); }
};

// GET /api/workspaces/:workspaceId/requests — admin-only (enforced inside
// listPendingJoinRequests itself).
export const listPendingJoinRequestsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const requests = await invitationsService.listPendingJoinRequests(req.user!.id, req.params.workspaceId);
    res.json(requests);
  } catch (err) { next(err); }
};

// PUT /api/workspaces/:workspaceId/requests/:requestId — admin-only
// (enforced inside resolveJoinRequest itself).
export const resolveJoinRequestHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await invitationsService.resolveJoinRequest(
      req.user!.id,
      req.params.workspaceId,
      req.params.requestId,
      req.body.action
    );
    res.json(result);
  } catch (err) { next(err); }
};
