import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthenticatedRequest } from '../middleware/index';
import { sendInviteEmail } from '../utils/mailer';

const router = Router();

// All invitation routes require authentication
router.use(authenticate);

router.get('/', async (req: AuthenticatedRequest, res, next) => {
  try {
    const invitations = await prisma.invitation.findMany({
      where: { inviterId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(invitations);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: AuthenticatedRequest, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email required' });
    }

    // Create invitation record in DB
    const invitation = await prisma.invitation.create({
      data: {
        email,
        inviterId: req.user!.id,
      },
    });

    // Build invite link using the APP_URL env var (no hardcoded localhost)
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const inviteLink = `${appUrl}/join/${invitation.token}`;

    // Send email
    await sendInviteEmail(email, inviteLink);

    res.status(201).json({
      success: true,
      message: 'Invite sent successfully',
      token: invitation.token,
      id: invitation.id,
    });
  } catch (err) {
    next(err);
  }
});

export default router;