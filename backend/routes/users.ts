import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { authenticate } from '../middleware/index.ts';

const router = Router();

router.get('/', authenticate, async (req, res, next) => {
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
