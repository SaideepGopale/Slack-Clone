import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { prisma } from '../lib/prisma';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not set.');
}

// ------------------- EXISTING ROUTES -------------------

router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }

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

// ------------------- NEW PASSWORD RESET ROUTES -------------------

// Admin Login Route
router.post('/admin/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Hardcoded admin credentials (in production, store securely in DB)
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@slack.com';
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      const token = jwt.sign(
        { id: 'admin', username: 'Admin', role: 'admin' },
        JWT_SECRET as string,
        { expiresIn: '7d' }
      );
      return res.json({ 
        token, 
        user: { 
          id: 'admin', 
          username: 'Admin', 
          email: ADMIN_EMAIL,
          role: 'admin'
        } 
      });
    }

    res.status(401).json({ error: 'Invalid admin credentials' });
  } catch (err) { next(err); }
});

// Get Admin Dashboard Stats
router.get('/admin/stats', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET as string) as any;

    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const totalUsers = await prisma.user.count();
    const totalChannels = await prisma.channel.count();
    const totalMessages = await prisma.message.count();
    const users = await prisma.user.findMany({
      select: { id: true, username: true, email: true, createdAt: true }
    });

    res.json({
      totalUsers,
      totalChannels,
      totalMessages,
      users
    });
  } catch (err) { next(err); }
});

// 1. Send Reset Email
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Security best practice: Don't reveal if user exists or not, just return success
      return res.json({ message: 'If an account exists, a password reset link has been sent.' });
    }

    // Generate a secure one-time use token that expires in 15 minutes
    const secret = JWT_SECRET + user.password; // Appending password hash makes it a 1-time link
    const resetToken = jwt.sign({ id: user.id }, secret, { expiresIn: '15m' });

    // Link pointing to your frontend
    const resetLink = `http://localhost:5174/reset-password?token=${resetToken}&id=${user.id}`;

    // Setup Nodemailer
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    // Send the Email
    await transporter.sendMail({
      from: `"Slick Workspace" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: 'Password Reset Request - Slick Workspace',
      html: `
        <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #350d36;">Reset Your Password</h2>
          <p>We received a request to reset your password for your Slick Workspace account.</p>
          <p>Click the button below to set a new password. This link is valid for <strong>15 minutes</strong>.</p>
          <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background-color: #e8912d; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin-top: 15px;">Set New Password</a>
          <p style="margin-top: 25px; font-size: 12px; color: #888;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `
    });

    res.json({ message: 'Reset email sent successfully' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// 2. Verify and Update New Password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { id, token, newPassword } = req.body;

    if (!id || !token || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify token using the same secret (JWT + old password)
    const secret = JWT_SECRET + user.password;
    try {
      jwt.verify(token, secret);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid or expired reset token. Please request a new one.' });
    }

    // Hash the new password and update
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword }
    });

    res.json({ message: 'Password updated successfully! You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;