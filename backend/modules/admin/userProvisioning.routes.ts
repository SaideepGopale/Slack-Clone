import { NextFunction, Response, Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as provisioning from './userProvisioning.service';

/**
 * P2 platform user provisioning. Mounted INSIDE the admin router, after its
 * `router.use(authenticate, requireAdmin)`, so every route here is platform-
 * admin only (role re-checked in the database on each request).
 */
const router = Router();

const handle =
  (fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

router.get('/users', handle(async (req, res) => res.json(await provisioning.listUsers(req.query))));
router.post('/users', handle(async (req, res) => res.status(201).json(await provisioning.createUser(req.user!.id, req.body))));
router.get('/users/:id', handle(async (req, res) => res.json(await provisioning.getUserDetails(req.params.id))));
router.patch('/users/:id/profile', handle(async (req, res) => res.json(await provisioning.updateUserProfile(req.user!.id, req.params.id, req.body))));
router.post('/users/:id/password', handle(async (req, res) => res.json(await provisioning.setUserPassword(req.user!.id, req.params.id, req.body))));

export default router;
