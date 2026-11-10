import { NextFunction, Response, Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { notifyUser } from '../../sockets/registry';
import { finishWorkspaceDetach } from '../members/members.realtime';
import * as organizations from './organizations.service';

const router = Router();
const readLimiter = userRateLimit(120, 60_000, 'Too many requests. Please slow down.');
const writeLimiter = userRateLimit(30, 60_000, 'Too many organization changes. Please slow down.');

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

// GET /api/organizations — organizations the caller belongs to.
router.get('/', ...requireSessionUser, readLimiter, handle(async (req, res) => {
  res.json(await organizations.listOrganizationsForUser(req.user!.id));
}));

// POST /api/organizations { name } — the creator becomes OWNER.
router.post('/', ...requireSessionUser, writeLimiter, handle(async (req, res) => {
  res.status(201).json(await organizations.createOrganization(req.user!.id, req.body?.name));
}));

// GET /api/organizations/:organizationId
router.get('/:organizationId', ...requireSessionUser, readLimiter, handle(async (req, res) => {
  res.json(await organizations.getOrganization(req.user!.id, req.params.organizationId));
}));

// PATCH /api/organizations/:organizationId { name }
router.patch('/:organizationId', ...requireSessionUser, writeLimiter, handle(async (req, res) => {
  res.json(await organizations.updateOrganization(req.user!.id, req.params.organizationId, req.body));
}));

// GET /api/organizations/:organizationId/members?q=&cursor=&limit=
router.get('/:organizationId/members', ...requireSessionUser, readLimiter, handle(async (req, res) => {
  res.json(await organizations.listOrganizationMembers(req.user!.id, req.params.organizationId, req.query));
}));

// PATCH /api/organizations/:organizationId/members/:userId { role: 'ADMIN' | 'MEMBER' }
router.patch('/:organizationId/members/:userId', ...requireSessionUser, writeLimiter, handle(async (req, res) => {
  res.json(
    await organizations.changeOrganizationRole(req.user!.id, req.params.organizationId, req.params.userId, req.body?.role)
  );
}));

// DELETE /api/organizations/:organizationId/members/:userId
router.delete('/:organizationId/members/:userId', ...requireSessionUser, writeLimiter, handle(async (req, res) => {
  const removal = await organizations.removeOrganizationMember(req.user!.id, req.params.organizationId, req.params.userId);
  // Same immediate revocation as a workspace removal, once per workspace.
  for (const { workspaceId, result } of removal.detached) {
    await finishWorkspaceDetach(removal.userId, workspaceId, result, 'removed');
  }
  notifyUser(removal.userId, 'organization:removed', { organizationId: removal.organizationId });
  res.json({ removed: true, organizationId: removal.organizationId, userId: removal.userId, workspaces: removal.detached.length });
}));

export default router;
