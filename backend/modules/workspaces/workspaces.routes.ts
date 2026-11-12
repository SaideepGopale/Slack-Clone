import { Router } from 'express';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { requireWorkspaceAccess } from '../../middleware/workspace.middleware';
import { listChannelsForWorkspaceHandler, listDMsForWorkspaceHandler } from '../channels/channels.controller';
import {
  createWorkspaceInviteHandler,
  getWorkspaceInviteLinkHandler,
  joinWorkspaceHandler,
  listPendingJoinRequestsHandler,
  listWorkspaceInvitationsHandler,
  resolveJoinRequestHandler,
  revokeInvitationHandler,
  revokeInviteLinksHandler,
} from '../invitations/invitations.controller';
import {
  createWorkspaceHandler,
  deleteWorkspaceHandler,
  getWorkspaceSettingsHandler,
  listWorkspacesHandler,
  updateWorkspaceSettingsHandler,
} from './workspaces.controller';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';

const settingsLimiter = userRateLimit(30, 60_000, 'Too many settings changes. Please slow down.');
// Batch 3/E: invitation/join traffic was unlimited (audit).
const inviteLimiter = userRateLimit(30, 60_000, 'Too many invitation requests. Please slow down.');
const joinLimiter = userRateLimit(20, 60_000, 'Too many join attempts. Please slow down.');

const router = Router();

router.get('/', ...requireSessionUser, listWorkspacesHandler);
router.post('/', ...requireSessionUser, createWorkspaceHandler);
// Static path — registered before the /:workspaceId param routes below by
// convention, though it wouldn't actually collide with any of them (none
// are a bare POST /:workspaceId).
router.post('/join', ...requireSessionUser, joinLimiter, joinWorkspaceHandler);
// requireWorkspaceAccess reads workspaceId from req.params here — only a
// member of :workspaceId can list its channels.
router.get('/:workspaceId/channels', ...requireSessionUser, requireWorkspaceAccess, listChannelsForWorkspaceHandler);
router.get('/:workspaceId/dms', ...requireSessionUser, requireWorkspaceAccess, listDMsForWorkspaceHandler);
// Invitations, invite links and join requests (Batch 3/E): lib/policy
// 'workspace.manageInvitations' is enforced inside the service — no
// membership middleware, so organization managers can manage access too.
router.post('/:workspaceId/invites', ...requireSessionUser, inviteLimiter, createWorkspaceInviteHandler);
router.get('/:workspaceId/invitations', ...requireSessionUser, listWorkspaceInvitationsHandler);
router.delete('/:workspaceId/invitations/:invitationId', ...requireSessionUser, inviteLimiter, revokeInvitationHandler);
router.get('/:workspaceId/invite-link', ...requireSessionUser, inviteLimiter, getWorkspaceInviteLinkHandler);
router.delete('/:workspaceId/invite-link', ...requireSessionUser, inviteLimiter, revokeInviteLinksHandler);
router.get('/:workspaceId/requests', ...requireSessionUser, listPendingJoinRequestsHandler);
router.put('/:workspaceId/requests/:requestId', ...requireSessionUser, inviteLimiter, resolveJoinRequestHandler);
// lib/policy 'workspace.delete' (owner-level) is enforced inside deleteWorkspace.
router.delete('/:workspaceId', ...requireSessionUser, deleteWorkspaceHandler);
// Workspace settings (Batch 3/B). No requireWorkspaceAccess here on purpose:
// organization owners/admins may manage a workspace without being a member —
// lib/policy decides (management never grants channel/message access).
router.get('/:workspaceId/settings', ...requireSessionUser, getWorkspaceSettingsHandler);
router.patch('/:workspaceId', ...requireSessionUser, settingsLimiter, updateWorkspaceSettingsHandler);

export default router;
