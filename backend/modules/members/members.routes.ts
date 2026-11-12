import { NextFunction, Response, Router } from 'express';
import { ChannelScopedRequest, requireChannelMembership } from '../../middleware/channelAccess.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { requireWorkspaceAccess, WorkspaceScopedRequest } from '../../middleware/workspace.middleware';
import { notifyUser, subscribeUserToChannel } from '../../sockets/registry';
import { addWorkspacePresence } from '../../sockets/presence.handlers';
import * as members from './members.service';
import { finishWorkspaceDetach } from './members.realtime';
import { ensureOrganizationMembership, pruneOrganizationMembership } from '../organizations/organizations.service';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { assertWorkspace, canSeeWorkspaceMemberEmails, DirectoryViewer, loadWorkspaceActor } from '../../lib/policy';
import { revokeChannelAccess } from '../../sockets/revocation';
import { announceMembersChanged } from '../channels/channelManagement.realtime';
import { removeChannelMember } from '../channels/channelManagement.service';

const router = Router();
const directoryLimiter = userRateLimit(120, 60_000, 'Too many directory requests. Please slow down.');
const writeLimiter = userRateLimit(30, 60_000, 'Too many membership changes. Please slow down.');

// Batch 3/E: the member directory is lib/policy 'workspace.viewMembers' —
// members, plus organization OWNER/ADMINs who manage the workspace without
// belonging to it (they need it to remove members or change roles).
// P1-D (FA-SEC-03): the same actor decides whether the viewer may also see
// other members' e-mails (lib/policy canSeeWorkspaceMemberEmails).
const directoryViewer = async (req: AuthenticatedRequest): Promise<DirectoryViewer> => {
  const actor = await loadWorkspaceActor(req.user!.id, req.params.workspaceId);
  assertWorkspace(actor, 'workspace.viewMembers');
  return { id: req.user!.id, canSeeEmails: canSeeWorkspaceMemberEmails(actor) };
};

// GET /api/workspaces/:workspaceId/members?q=&cursor=&limit=
router.get(
  '/workspaces/:workspaceId/members',
  ...requireSessionUser,
  directoryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const viewer = await directoryViewer(req);
      res.json(await members.listMembers(viewer, req.params.workspaceId, req.query));
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/workspaces/:workspaceId/members/:userId — profile within this workspace.
router.get(
  '/workspaces/:workspaceId/members/:userId',
  ...requireSessionUser,
  directoryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const viewer = await directoryViewer(req);
      res.json(await members.getMemberProfile(viewer, req.params.workspaceId, req.params.userId));
    } catch (err) {
      next(err);
    }
  }
);

// P2 — GET /api/workspaces/:workspaceId/member-candidates?q= (managers only)
router.get(
  '/workspaces/:workspaceId/member-candidates',
  ...requireSessionUser,
  directoryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await members.searchMemberCandidates(req.user!.id, req.params.workspaceId, req.query));
    } catch (err) {
      next(err);
    }
  }
);

// P2 — POST /api/workspaces/:workspaceId/members { userId }: a manager adds an
// existing account directly. Its open sockets gain the workspace and General
// at once, and its workspace list refreshes live.
router.post(
  '/workspaces/:workspaceId/members',
  ...requireSessionUser,
  writeLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId } = req.params;
      const result = await members.addWorkspaceMember(req.user!.id, workspaceId, req.body?.userId);
      await ensureOrganizationMembership(workspaceId, result.userId);
      subscribeUserToChannel(result.userId, result.generalChannelId);
      addWorkspacePresence(result.userId, workspaceId);
      notifyUser(result.userId, 'workspace:member_updated', { workspaceId, userId: result.userId, role: 'MEMBER' });
      res.status(201).json(result.member);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/workspaces/:workspaceId/members/:userId — lib/policy decides
// (no membership middleware: organization managers may remove members).
router.delete(
  '/workspaces/:workspaceId/members/:userId',
  ...requireSessionUser,
  writeLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, userId } = req.params;
      const result = await members.removeWorkspaceMember(req.user!.id, workspaceId, userId);
      await finishWorkspaceDetach(userId, workspaceId, result, 'removed');
      await pruneOrganizationMembership(workspaceId, userId);
      res.json({ removed: true, workspaceId, userId });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/workspaces/:workspaceId/members/:userId { role: 'ADMIN' | 'MEMBER' }
// No requireWorkspaceAccess: organization managers may change roles without
// being workspace members — lib/policy decides.
router.patch(
  '/workspaces/:workspaceId/members/:userId',
  ...requireSessionUser,
  writeLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await members.changeWorkspaceMemberRole(req.user!.id, req.params.workspaceId, req.params.userId, req.body?.role));
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/workspaces/:workspaceId/leave
router.post(
  '/workspaces/:workspaceId/leave',
  ...requireSessionUser,
  writeLimiter,
  requireWorkspaceAccess,
  async (req: WorkspaceScopedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await members.leaveWorkspace(req.user!.id, req.params.workspaceId);
      await finishWorkspaceDetach(req.user!.id, req.params.workspaceId, result, 'left');
      await pruneOrganizationMembership(req.params.workspaceId, req.user!.id);
      res.json({ left: true, workspaceId: req.params.workspaceId });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/channels/:id/leave
router.post(
  '/channels/:id/leave',
  ...requireSessionUser,
  writeLimiter,
  requireChannelMembership,
  async (req: ChannelScopedRequest, res: Response, next: NextFunction) => {
    try {
      await members.leaveChannel(req.user!.id, req.channelAccess!);
      await revokeChannelAccess(req.user!.id, [req.params.id]);
      notifyUser(req.user!.id, 'conversation:removed', { channelId: req.params.id });
      await announceMembersChanged(req.params.id, [{ change: 'removed', userId: req.user!.id }]);
      res.json({ left: true, channelId: req.params.id });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/channels/:id/members/:userId — owner, moderators (members only)
// or workspace managers (Batch 3/D, lib/policy). No membership middleware:
// managers manage channels they don't belong to (decision 5).
router.delete(
  '/channels/:id/members/:userId',
  ...requireSessionUser,
  writeLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const removed = await removeChannelMember(req.user!.id, req.params.id, req.params.userId);
      await revokeChannelAccess(removed.userId, [removed.channelId]);
      notifyUser(removed.userId, 'conversation:removed', { channelId: removed.channelId });
      await announceMembersChanged(removed.channelId, [{ change: 'removed', userId: removed.userId }]);
      res.json({ removed: true, channelId: removed.channelId, userId: removed.userId });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
