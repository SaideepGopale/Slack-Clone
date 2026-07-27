import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { APP_URL, JWT_SECRET } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { sendInviteEmail } from '../../utils/mailer';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const listInvitations = (inviterId: string) =>
  prisma.invitation.findMany({ where: { inviterId }, orderBy: { createdAt: 'desc' } });

// Only a workspace ADMIN can invite people into it — otherwise anyone with a
// valid session could invite strangers into any tenant just by knowing its id.
const assertIsWorkspaceAdmin = async (userId: string, workspaceId: string) => {
  const membership = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (!membership || membership.role !== 'ADMIN') {
    throw new HttpError(403, 'Only a workspace admin can send invitations for this workspace.');
  }
};

export const createInvitation = async (email: string, inviterId: string, workspaceId: string) => {
  if (!email || typeof email !== 'string') {
    throw new HttpError(400, 'Valid email required');
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new HttpError(400, 'Invalid email format');
  }
  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new HttpError(400, 'workspaceId is required');
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
  if (!workspace) {
    throw new HttpError(404, 'Workspace not found');
  }

  await assertIsWorkspaceAdmin(inviterId, workspaceId);

  // Inviting someone who already has an account is the whole point now (see
  // acceptInvitation/isExistingUser) — what actually needs blocking is
  // inviting someone who's already IN this specific workspace, which would
  // just be a confusing no-op invite.
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    const alreadyMember = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: existingUser.id, workspaceId } },
    });
    if (alreadyMember) {
      throw new HttpError(400, 'This user is already a member of this workspace.');
    }
  }

  const invitation = await prisma.invitation.create({ data: { email, inviterId, workspaceId } });
  const inviteLink = `${APP_URL}/invite/${invitation.token}`;

  try {
    await sendInviteEmail(email, inviteLink, workspace.name);
  } catch (emailErr: any) {
    console.error('Email sending failed:', emailErr.message);
    return {
      status: 201,
      body: {
        success: true,
        message: 'Invitation created but email failed to send',
        token: invitation.token,
        id: invitation.id,
        emailError: emailErr.message,
      },
    };
  }

  return {
    status: 201,
    body: { success: true, message: 'Invite sent successfully', token: invitation.token, id: invitation.id },
  };
};

/**
 * Public token inspection — no auth required, since InviteHandler.tsx calls
 * this before it knows whether the visitor is logged in at all. The
 * `isExistingUser` flag is what lets the frontend decide whether to route the
 * visitor to /login (existing account) or /signup (brand-new invitee)
 * without ever needing to attempt a login itself just to find out.
 */
export const getInvitationByToken = async (token: string) => {
  if (!token) throw new HttpError(400, 'Invalid invitation token');

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { workspace: { select: { id: true, name: true } } },
  });
  if (!invitation) throw new HttpError(404, 'Invitation not found or expired');
  if (invitation.status !== 'pending') {
    throw new HttpError(400, 'This invitation has already been used.');
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });

  return {
    valid: true as const,
    email: invitation.email,
    workspaceId: invitation.workspace.id,
    workspaceName: invitation.workspace.name,
    isExistingUser: !!existingUser,
  };
};

/**
 * Consumes an invitation for the CALLER'S OWN, already-authenticated session
 * — this never creates an account itself. A brand-new invitee is routed
 * through the normal signup+OTP flow first (InviteHandler -> /signup), and
 * this only ever runs once a real session exists, for either a fresh signup
 * or an existing login. Requires the session's email to match the invited
 * address; without that check, any already-logged-in account could consume
 * someone else's invite just by having their token URL.
 */
export const acceptInvitation = async (token: string, userId: string) => {
  if (!token) throw new HttpError(400, 'Invalid invitation token');

  const invitation = await prisma.invitation.findUnique({ where: { token } });
  if (!invitation) throw new HttpError(404, 'Invitation not found or expired');
  if (invitation.status !== 'pending') {
    throw new HttpError(400, 'This invitation has already been used.');
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new HttpError(404, 'User not found');
  if (user.email !== invitation.email) {
    throw new HttpError(403, `This invitation was sent to ${invitation.email}, not the account you're signed in as.`);
  }

  const generalChannel = await prisma.channel.findFirst({
    where: { name: 'General', isDM: false, workspaceId: invitation.workspaceId },
  });
  if (!generalChannel) {
    throw new HttpError(500, 'This workspace has no "General" channel to join — contact an admin.');
  }

  try {
    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: { userId_workspaceId: { userId, workspaceId: invitation.workspaceId } },
        update: {},
        create: { userId, workspaceId: invitation.workspaceId, role: 'MEMBER' },
      }),
      prisma.channelMember.upsert({
        where: { userId_channelId: { userId, channelId: generalChannel.id } },
        update: {},
        create: { userId, channelId: generalChannel.id, role: 'member' },
      }),
      prisma.invitation.update({ where: { token }, data: { status: 'accepted' } }),
    ]);
  } catch (err) {
    // P2002 = unique constraint violation. Two near-simultaneous accept
    // calls for the same invite (React StrictMode's double effect-fire in
    // dev, a double-click, a retried request) can both read status:
    // 'pending' before either commits, then race on the same upsert's
    // create path — reproduced directly via two rapid-fire requests during
    // manual testing. Whichever loses the race didn't corrupt anything: the
    // membership/channel-membership rows it wanted now exist regardless, so
    // this is a no-op success, not a real failure.
    const isDuplicateRace = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
    if (!isDuplicateRace) throw err;
  }

  return { workspaceId: invitation.workspaceId, generalChannelId: generalChannel.id };
};

// Discord/Slack-style reusable invite link — a stateless alternative to the
// per-email Invitation flow above, added because email delivery isn't
// reliably reachable right now (see mailer.ts). Deliberately NOT an
// Invitation DB row: nothing to look up by email, no single recipient to
// lock it to — the JWT itself carries everything needed (just the
// workspaceId), so anyone holding the link can join. Trade-off: unlike a
// DB-backed invite, this can't be individually revoked/tracked short of
// rotating JWT_SECRET (which would also invalidate every login session) —
// acceptable for now, revisit if per-link revocation is ever needed.
const WORKSPACE_JOIN_TOKEN_TTL = '7d';

interface WorkspaceJoinTokenPayload {
  workspaceId: string;
}

export const getWorkspaceInviteLink = async (adminId: string, workspaceId: string) => {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!workspace) {
    throw new HttpError(404, 'Workspace not found');
  }
  await assertIsWorkspaceAdmin(adminId, workspaceId);

  const token = jwt.sign({ workspaceId } as WorkspaceJoinTokenPayload, JWT_SECRET as string, {
    expiresIn: WORKSPACE_JOIN_TOKEN_TTL,
  });

  return { url: `${APP_URL}/join-workspace?token=${token}` };
};

// Authenticated — consumes the link for whoever is currently signed in,
// same trust model as acceptInvitation above. No email-match check here
// (unlike acceptInvitation): this link was never bound to a specific
// recipient in the first place.
export const joinWorkspaceViaLink = async (userId: string, token: string) => {
  if (!token || typeof token !== 'string') {
    throw new HttpError(400, 'Invalid invite link');
  }

  let payload: WorkspaceJoinTokenPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET as string) as WorkspaceJoinTokenPayload;
  } catch {
    throw new HttpError(400, 'This invite link is invalid or has expired.');
  }

  const { workspaceId } = payload;
  if (!workspaceId) {
    throw new HttpError(400, 'Invalid invite link');
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) {
    throw new HttpError(404, 'This workspace no longer exists.');
  }

  const generalChannel = await prisma.channel.findFirst({
    where: { name: 'General', isDM: false, workspaceId },
  });
  if (!generalChannel) {
    throw new HttpError(500, 'This workspace has no "General" channel to join — contact an admin.');
  }

  try {
    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: { userId_workspaceId: { userId, workspaceId } },
        update: {},
        create: { userId, workspaceId, role: 'MEMBER' },
      }),
      prisma.channelMember.upsert({
        where: { userId_channelId: { userId, channelId: generalChannel.id } },
        update: {},
        create: { userId, channelId: generalChannel.id, role: 'member' },
      }),
    ]);
  } catch (err) {
    // Same benign race as acceptInvitation above (P2002 on a near-simultaneous
    // double-click/StrictMode double-fire) — the rows exist regardless of
    // which call "won", so this is a no-op success, not a real failure.
    const isDuplicateRace = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
    if (!isDuplicateRace) throw err;
  }

  return { workspaceId, generalChannelId: generalChannel.id };
};

export { HttpError };
