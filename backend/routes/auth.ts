import bcrypt from 'bcryptjs';
import crypto from 'crypto'; // NAYA IMPORT: Token generate karne ke liye
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { sendResetPasswordEmail } from '../utils/mailer'; // NAYA IMPORT: Email bhejne ke liye

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not set.');
}

// ==========================================
// 1. REGISTER ROUTE
// ==========================================
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

// ==========================================
// 2. LOGIN ROUTE
// ==========================================
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

// ==========================================
// 3. GET CURRENT USER ROUTE
// ==========================================
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

// ==========================================
// 4. FORGOT PASSWORD ROUTE (NAYA FEATURE)
// ==========================================
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: 'User with this email does not exist' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 3600000); // 1 ghante mein expire

    await prisma.user.update({
      where: { email },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExpires: tokenExpiry,
      },
    });

    const resetLink = `http://localhost:5173/reset-password/${resetToken}`;
    await sendResetPasswordEmail(email, resetLink);

    res.status(200).json({ message: 'Reset link sent successfully' });
  } catch (err) { 
    next(err); 
  }
});

// ==========================================
// 5. RESET PASSWORD ROUTE (NAYA FEATURE)
// ==========================================
router.post('/reset-password/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'New password is required' });
    }

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpires: { gt: new Date() }, // Time check
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    res.status(200).json({ message: 'Password reset successfully' });
  } catch (err) { 
    next(err); 
  }
});

export default router;