import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthenticatedRequest } from '../middleware/index';

// Infer member type from Prisma's return type
type ChannelWithMembers = Awaited<ReturnType<PrismaClient['channel']['findMany']>>[number] & {
  members: Array<{ userId: string; user: { id: string; username: string } }>;
};

const router = Router();

router.get('/', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try { 
    const channels = await prisma.channel.findMany({
      where: {
        members: {
          some: { userId: req.user!.id }
        }
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true }
            }
          }
        }
      }
    });

    // Map channels to include dynamic naming for DMs
    const mappedChannels = (channels as ChannelWithMembers[]).map(chan => {
      if (chan.isDM) {
        const otherMember = chan.members.find((m: { userId: string }) => m.userId !== req.user!.id);
        return {
          ...chan,
          name: otherMember ? (otherMember as ChannelWithMembers['members'][number]).user.username : 'Direct Message'
        };
      }
      return chan;
    });

    res.json(mappedChannels); 
  } catch (err) { next(err); }
});

router.post('/dm', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { targetUserId } = req.body;
    const currentUserId = req.user!.id;

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: 'Cannot create DM with yourself' });
    }

    // Find existing DM
    const existingDM = await prisma.channel.findFirst({
      where: {
        isDM: true,
        AND: [
          { members: { some: { userId: currentUserId } } },
          { members: { some: { userId: targetUserId } } }
        ]
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true }
            }
          }
        }
      }
    });

    if (existingDM) {
      const otherMember = (existingDM as ChannelWithMembers).members.find((m: { userId: string }) => m.userId !== currentUserId);
      return res.json({
        ...existingDM,
        name: otherMember ? (otherMember as ChannelWithMembers['members'][number]).user.username : 'Direct Message'
      });
    }

    // Create new DM
    const newDM = await prisma.channel.create({
      data: {
        isDM: true,
        createdBy: currentUserId,
        members: {
          create: [
            { userId: currentUserId, role: 'member' },
            { userId: targetUserId, role: 'member' }
          ]
        }
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true }
            }
          }
        }
      }
    });

    const otherMember = (newDM as ChannelWithMembers).members.find((m: { userId: string }) => m.userId !== currentUserId);
    res.json({
      ...newDM,
      name: otherMember ? (otherMember as ChannelWithMembers['members'][number]).user.username : 'Direct Message'
    });
  } catch (err) { next(err); }
});

router.get('/all', authenticate, async (req, res, next) => {
  try {
    const channels = await prisma.channel.findMany({
      where: { isDM: false }
    });
    res.json(channels);
  } catch (err) { next(err); }
});

router.post('/', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    const channel = await prisma.$transaction(async (tx) => {
      const newChannel = await tx.channel.create({ 
        data: {
          name: req.body.name,
          createdBy: req.user!.id
        }
      });
      
      await tx.channelMember.create({
        data: {
          channelId: newChannel.id,
          userId: req.user!.id,
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

router.post('/:id/join', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    const membership = await prisma.channelMember.upsert({
      where: {
        userId_channelId: {
          userId: req.user!.id,
          channelId: req.params.id
        }
      },
      update: {},
      create: {
        userId: req.user!.id,
        channelId: req.params.id,
        role: 'member'
      }
    });
    res.json(membership);
  } catch (err) { next(err); }
});

export default router;
