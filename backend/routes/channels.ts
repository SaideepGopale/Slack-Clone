import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthenticatedRequest } from '../middleware/index';

// Infer member type from Prisma's return type
type ChannelWithMembers = Awaited<ReturnType<PrismaClient['channel']['findMany']>>[number] & {
  members: Array<{ userId: string; user: { id: string; username: string } }>;
};

const router = Router();

// Check if user is admin
const isAdmin = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.email === 'admin@slack.com' || user?.email?.includes('admin@');
};

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

// 👇 ADMIN: Get ALL channels (regardless of membership)
router.get('/admin/all', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    const admin = await isAdmin(req.user!.id);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const channels = await prisma.channel.findMany({
      where: { isDM: false },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(channels);
  } catch (err) { next(err); }
});

router.post('/dm', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { targetUserId } = req.body;
    const currentUserId = req.user!.id;

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: 'Cannot create DM with yourself' });
    }

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
      // 1️⃣ Naya channel banao
      const newChannel = await tx.channel.create({ 
        data: {
          name: req.body.name,
          description: req.body.description || null,
          createdBy: req.user!.id
        }
      });
      
      // 2️⃣ Sabhi users ko fetch karo
      const allUsers = await tx.user.findMany({
        select: { id: true }
      });
      
      // 3️⃣ Sabhi users ko channel mein add karo
      await tx.channelMember.createMany({
        data: allUsers.map(user => ({
          channelId: newChannel.id,
          userId: user.id,
          role: user.id === req.user!.id ? 'admin' : 'member'
        }))
      });
      
      return newChannel;
    });
    
    res.json(channel);
  } catch (err) { next(err); }
});

// --- DELETE CHANNEL (ADMIN ONLY) ---
router.delete('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    const admin = await isAdmin(req.user!.id);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    // Protect general channel
    if (channel.name && channel.name.toLowerCase() === 'general') {
      return res.status(403).json({ error: 'Cannot delete the general channel' });
    }

    await prisma.channel.delete({ where: { id: req.params.id } });
    res.json({ message: 'Channel deleted successfully' });
  } catch (err) { next(err); }
});

router.get('/:id/messages', authenticate, async (req, res, next) => {
  try {
    const messages = await prisma.message.findMany({
      where: { channelId: req.params.id },
      include: {
        sender: {
          select: { id: true, username: true }
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
          select: { id: true, username: true }
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