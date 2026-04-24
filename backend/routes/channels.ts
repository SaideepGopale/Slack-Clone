import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { authenticate } from '../middleware/index.ts';

const router = Router();

router.get('/', authenticate, async (req, res, next) => {
  try { 
    const channels = await prisma.channel.findMany();
    res.json(channels); 
  } catch (err) { next(err); }
});

router.post('/', authenticate, async (req: any, res, next) => {
  try {
    const channel = await prisma.$transaction(async (tx) => {
      const newChannel = await tx.channel.create({ 
        data: {
          name: req.body.name,
          createdBy: req.user.id
        }
      });
      
      await tx.channelMember.create({
        data: {
          channelId: newChannel.id,
          userId: req.user.id,
          role: 'admin'
        }
      });
      
      return newChannel;
    });
    
    res.json(channel);
  } catch (err) { next(err); }
});

router.get('/:id/messages', authenticate, async (req, res, next) => {
  try {
    const messages = await prisma.message.findMany({
      where: { channelId: req.params.id },
      include: {
        sender: {
          select: { username: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    });
    res.json(messages);
  } catch (err) { next(err); }
});

export default router;
