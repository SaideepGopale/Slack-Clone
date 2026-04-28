import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { authenticate } from '../middleware/index.ts';

const router = Router();

router.get('/', authenticate, async (req: any, res, next) => {
  try {
    const invitations = await prisma.invitation.findMany({
      where: { inviterId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json(invitations);
  } catch (err) { next(err); }
});

router.post('/', authenticate, async (req: any, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const invitation = await prisma.invitation.create({
      data: {
        email,
        inviterId: req.user.id
      }
    });

    res.status(201).json(invitation);
  } catch (err) { next(err); }
});

export default router;
