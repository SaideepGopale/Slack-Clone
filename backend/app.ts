import cors from 'cors';
import express from 'express';
import { APP_URL, NODE_ENV } from './config/env';
import { prisma } from './lib/prisma';
import { errorHandler } from './middleware/error.middleware';
import { revokeSocketsOnUserDeletion } from './middleware/socketRevocation.middleware';
import adminRoutes from './modules/admin/admin.routes';
import authRoutes from './modules/auth/auth.routes';
import channelsRoutes from './modules/channels/channels.routes';
import invitationsRoutes from './modules/invitations/invitations.routes';
import messagesRoutes, { messageActionsRouter } from './modules/messages/messages.routes';
import previewRoutes from './modules/preview/preview.routes';
import readStateRoutes from './modules/readState/readState.routes';
import groupDMRoutes from './modules/groupDMs/groupDMs.routes';
import memberRoutes from './modules/members/members.routes';
import notificationRoutes from './modules/notifications/notifications.routes';
import organizationRoutes from './modules/organizations/organizations.routes';
import projectRoutes from './modules/projects/projects.routes';
import { accountActivationRoutes, teamManagementRoutes, teamMemberRoutes } from './modules/teamManagement/teamManagement.routes';
import { INVITE_ONLY_SIGNUP_PATHS, requireSignupInvitation, signupGateLimiter } from './middleware/inviteOnlySignup.middleware';
import { companyOverviewRoutes } from './modules/companyOverview/companyOverview.routes';
import uploadRoutes, { handleUploadErrors } from './modules/uploads/message.routes';
import { uploadDir } from './modules/uploads/storage.service';
import usersRoutes from './modules/users/users.routes';
import workspacesRoutes from './modules/workspaces/workspaces.routes';

const allowedOrigins = [APP_URL, 'http://localhost:5173'];

export const app = express();

// P3 (FA-SEC-10, code part): don't advertise the framework, and send baseline
// hardening headers on every response (the API only ever returns JSON/files).
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else if (NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir));

app.get('/api/health', async (_req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl) return res.status(503).json({ database: 'missing_config', message: 'DATABASE_URL not set' });
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ database: 'connected' });
  } catch {
    res.status(503).json({ database: 'error', message: 'Connection failed' });
  }
});

// Stage 2 finalization (T.21): sign-up is invitation-only. The gate runs in
// front of the unchanged auth router for the three sign-up endpoints only —
// login, /me, password reset, JWT and sessions are not involved.
app.post(INVITE_ONLY_SIGNUP_PATHS, signupGateLimiter, requireSignupInvitation);
app.use('/api/auth', authRoutes);
app.use('/api/channels', channelsRoutes);
app.use('/api/channels', messagesRoutes);
app.use('/api/messages', messageActionsRouter);
app.use('/api/users', usersRoutes);
app.use('/api/invitations', invitationsRoutes);
// FA-RT-03: observes DELETE /api/admin/users/:id and, once that deletion
// succeeds, disconnects the deleted user's live sockets. Never short-circuits;
// the admin router below still authenticates, authorizes and deletes.
app.use('/api/admin', revokeSocketsOnUserDeletion);
app.use('/api/admin', adminRoutes);
// message.routes.ts declares the full "/upload" path itself, so this mounts
// at the API root — the resulting endpoint is still POST /api/upload,
// exactly matching the frontend's existing call site (ChatArea.tsx), so no
// frontend changes were needed for this migration to Cloudinary.
app.use('/api', uploadRoutes);
// Scoped specifically to the upload route above (see message.routes.ts) —
// catches MulterError/fileFilter rejections with a clean 400 before they'd
// otherwise fall through to the generic 500 handler at the bottom of this file.
//
// Path MUST be scoped to '/api/upload' here: an error-handling middleware
// mounted with no path (app.use(handleUploadErrors)) matches every route,
// not just the one after it in the file — Express walks forward through the
// whole stack looking for the next 4-arg handler when next(err) is called,
// regardless of where the error originated. Unscoped, this was silently
// swallowing every HttpError thrown anywhere in auth/channels/messages/etc.
// (login, signup, channel creation, ...) and force-flattening it to a 400
// with the wrong body shape ({success, message} instead of errorHandler's
// {error}) before it ever reached the real status code or the bottom-of-file
// errorHandler — caught by the login integration test expecting a 401 on bad
// credentials and getting a 400 instead.
app.use('/api/upload', handleUploadErrors);
app.use('/api/workspaces', workspacesRoutes);

// Link previews: authenticated, rate-limited, SSRF-safe (modules/preview).
app.use('/api', previewRoutes);
// Persistent read state + read receipts (modules/readState).
app.use('/api', readStateRoutes);
// Group direct messages (modules/groupDMs).
app.use('/api', groupDMRoutes);
// Workspace People directory, profiles, membership removal (modules/members).
app.use('/api', memberRoutes);
// P2 Phase I: Activity feed and workspace search.
app.use('/api', notificationRoutes);
// Organizations — top of the Organization → Workspace → Channel hierarchy (Batch 3).
app.use('/api/organizations', organizationRoutes);
// Batch 3/C: projects (/api/workspaces/:id/projects, /api/projects/...).
app.use('/api', projectRoutes);
// Stage 2 (T.20): Company Admin → Team Lead provisioning (admin-only), and the
// public one-time account activation (rate limited, issues no session).
app.use('/api/team-management', teamManagementRoutes);
app.use('/api/account-activation', accountActivationRoutes);
// Stage 3 (T.22): Team Lead → Member provisioning (/api/workspaces/:id/member-invitations…) and /api/me/hierarchy.
app.use('/api', teamMemberRoutes);
// Stage 4 (T.23): Company Admin workspace overview — read-only metadata, admin only.
app.use('/api/company-overview', companyOverviewRoutes);

app.use(errorHandler);
