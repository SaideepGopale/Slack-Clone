
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { sendResetPasswordEmail } from '../utils/mailer';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET environment variable is not set.'
  );
}

router.post(
  '/register',
  async (req, res, next) => {
    try {
      const {
        username,
        email,
        password,
      } = req.body;

      if (
        !username ||
        !email ||
        !password
      ) {
        return res.status(400).json({
          error:
            'username, email and password are required',
        });
      }

      const existingUser =
        await prisma.user.findFirst({
          where: {
            OR: [
              { email },
              { username },
            ],
          },
        });

      if (existingUser) {
        return res.status(400).json({
          error:
            'User with this email or username already exists',
        });
      }

      const hashedPassword =
        await bcrypt.hash(
          password,
          12
        );

      const user =
        await prisma.user.create({
          data: {
            username,
            email,
            password:
              hashedPassword,
          },
        });

      let generalChannel =
        await prisma.channel.findFirst(
          {
            where: {
              name: 'general',
            },
          }
        );

      if (!generalChannel) {
        generalChannel =
          await prisma.channel.create(
            {
              data: {
                name: 'general',
                createdBy:
                  user.id,
              },
            }
          );
      }

      await prisma.channelMember.upsert(
        {
          where: {
            userId_channelId: {
              userId: user.id,
              channelId:
                generalChannel.id,
            },
          },
          update: {},
          create: {
            userId: user.id,
            channelId:
              generalChannel.id,
            role: 'admin',
          },
        }
      );

      const token = jwt.sign(
        {
          id: user.id,
          username:
            user.username,
        },
        JWT_SECRET,
        {
          expiresIn: '7d',
        }
      );

      res.status(201).json({
        token,
        user: {
          id: user.id,
          username:
            user.username,
          email: user.email,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/login',
  async (req, res, next) => {
    try {
      const {
        email,
        password,
      } = req.body;

      if (
        !email ||
        !password
      ) {
        return res.status(400).json({
          error:
            'email and password are required',
        });
      }

      const user =
        await prisma.user.findUnique(
          {
            where: {
              email,
            },
          }
        );

      if (
        !user ||
        !(await bcrypt.compare(
          password,
          user.password
        ))
      ) {
        return res.status(401).json({
          error:
            'Invalid credentials',
        });
      }

      const token = jwt.sign(
        {
          id: user.id,
          username:
            user.username,
        },
        JWT_SECRET,
        {
          expiresIn: '7d',
        }
      );

      res.json({
        token,
        user: {
          id: user.id,
          username:
            user.username,
          email: user.email,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/me',
  async (req, res) => {
    try {
      const authHeader =
        req.headers.authorization;

      if (!authHeader) {
        return res
          .status(401)
          .json({
            error:
              'No token',
          });
      }

      const token =
        authHeader.split(
          ' '
        )[1];

      const decoded =
        jwt.verify(
          token,
          JWT_SECRET
        ) as {
          id: string;
        };

      const user =
        await prisma.user.findUnique(
          {
            where: {
              id: decoded.id,
            },
            select: {
              id: true,
              username: true,
              email: true,
            },
          }
        );

      if (!user) {
        return res
          .status(404)
          .json({
            error:
              'User not found',
          });
      }

      res.json(user);
    } catch (err) {
      res.status(401).json({
        error:
          'Invalid token',
      });
    }
  }
);

router.post(
  '/forgot-password',
  async (req, res) => {
    try {
      const { email } =
        req.body;

      if (!email) {
        return res
          .status(400)
          .json({
            error:
              'Email is required',
          });
      }

      const user =
        await prisma.user.findUnique(
          {
            where: {
              email,
            },
          }
        );

      if (!user) {
        return res
          .status(404)
          .json({
            error:
              'User not found',
          });
      }

      // generate a short-lived JWT token for password reset
      const resetToken = jwt.sign(
        { id: user.id },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      const frontendUrl =
        process.env.FRONTEND_URL ||
        'http://localhost:5173';

      const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

      // Verify email config is present; provide a dev fallback that logs the link
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.warn('Email config missing: EMAIL_USER or EMAIL_PASS not set');

        // In production we must fail. In development, log the reset link so developers can copy it.
        console.log(`Password reset link for ${email}: ${resetLink}`);

        if (process.env.NODE_ENV === 'production') {
          return res.status(500).json({ error: 'Email configuration missing on server' });
        }

        return res.json({ success: true, message: 'Password reset link printed to server console (dev mode)' });
      }

      // send email (may throw)
      try {
        await sendResetPasswordEmail(email, resetLink);
      } catch (err) {
        console.error('Failed to send reset email:', err);
        return res.status(500).json({
          error: 'Failed to send reset email',
        });
      }

      return res.json({ success: true, message: 'Password reset link sent successfully' });
    } catch (error) {
      console.error(error);

      return res
        .status(500)
        .json({
          error:
            'Failed to process forgot password request',
        });
    }
  }
);

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'token and password are required' });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET as string) as { id: string };
    } catch (err: any) {
      if (err.name === 'TokenExpiredError') {
        return res.status(400).json({ error: 'Reset token has expired' });
      }
      return res.status(401).json({ error: 'Invalid reset token' });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } });

    return res.json({ success: true, message: 'Password has been reset' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;
