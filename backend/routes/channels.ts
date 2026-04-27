import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { authenticate } from '../middleware/index.ts';

const router = Router();

router.get('/', authenticate, async (req: any, res, next) => {
  try { 
    const channels = await prisma.channel.findMany({
      where: {
        members: {
          some: { userId: req.user.id }
        }
      }
    });
    res.json(channels); 
  } catch (err) { next(err); }
});

router.get('/all', authenticate, async (req, res, next) => {
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

router.get('/:id/search', authenticate, async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);

    const messages = await prisma.message.findMany({
      where: {
        channelId: req.params.id,
        content: {
          contains: q as string,
          mode: 'insensitive'
        }
      },
      include: {
        sender: {
          select: { username: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(messages);
  } catch (err) { next(err); }
});

router.post('/:id/join', authenticate, async (req: any, res, next) => {
  try {
    const membership = await prisma.channelMember.upsert({
      where: {
        userId_channelId: {
          userId: req.user.id,
          channelId: req.params.id
        }
      },
      update: {},
      create: {
        userId: req.user.id,
        channelId: req.params.id,
        role: 'member'
      }
    });
    res.json(membership);
  } catch (err) { next(err); }
});

export default router;
