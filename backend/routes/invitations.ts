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

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Valid email required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
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
    try {
      await sendInviteEmail(email, inviteLink);
    } catch (emailErr: any) {
      console.error('Email sending failed:', emailErr.message);
      // Still return success but note that email wasn't sent
      return res.status(201).json({
        success: true,
        message: 'Invitation created but email failed to send',
        token: invitation.token,
        id: invitation.id,
        emailError: emailErr.message,
      });
    }

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

// Accept an invitation via token
router.post('/accept/:token', async (req: AuthenticatedRequest, res, next) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Invalid invitation token' });
    }

    // Find invitation by token
    const invitation = await prisma.invitation.findUnique({
      where: { token },
      include: { inviter: { select: { username: true, email: true } } },
    });

    if (!invitation) {
      return res.status(404).json({ success: false, message: 'Invitation not found or expired' });
    }

    if (invitation.status === 'accepted') {
      return res.status(400).json({ success: false, message: 'This invitation has already been accepted' });
    }

    // Mark invitation as accepted
    await prisma.invitation.update({
      where: { token },
      data: { status: 'accepted' },
    });

    res.json({
      success: true,
      message: 'Invitation accepted successfully',
      inviterId: invitation.inviterId,
      inviter: invitation.inviter,
    });
  } catch (err) {
    next(err);
  }
});

export default router;