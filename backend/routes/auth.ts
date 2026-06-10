import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not set.');
}

router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username }
        ]
      }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email or username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { username, email, password: hashedPassword }
    });

    // Auto-join #general if it exists, or create it
    let generalChannel = await prisma.channel.findFirst({
      where: { name: 'general' }
    });

    if (!generalChannel) {
      generalChannel = await prisma.channel.create({
        data: {
          name: 'general',
          createdBy: user.id
        }
      });
    }

    await prisma.channelMember.upsert({
      where: {
        userId_channelId: {
          userId: user.id,
          channelId: generalChannel.id
        }
      },
      update: {},
      create: {
        userId: user.id,
        channelId: generalChannel.id,
        role: 'admin'
      }
    });

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET as string,
      { expiresIn: '7d' }
    );
    res.status(201).json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET as string,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) { next(err); }
});

router.get('/me', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET as string) as { id: string };

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, username: true, email: true }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json(user);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
