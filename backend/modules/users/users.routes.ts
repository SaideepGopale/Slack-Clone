import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { listUsersHandler } from './users.controller';

const router = Router();

router.get('/', authenticate, listUsersHandler);

export default router;
