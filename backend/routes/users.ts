import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/index';

const router = Router();

router.get('/', authenticate, async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
      }
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

export default router;
