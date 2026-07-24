import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';
import express from 'express';
import { APP_URL, NODE_ENV } from './config/env';
import { prisma } from './lib/prisma';
import { errorHandler } from './middleware/error.middleware';
import adminRoutes from './modules/admin/admin.routes';
import authRoutes from './modules/auth/auth.routes';
import channelsRoutes from './modules/channels/channels.routes';
import invitationsRoutes from './modules/invitations/invitations.routes';
import messagesRoutes, { messageActionsRouter } from './modules/messages/messages.routes';
import uploadRoutes, { handleUploadErrors } from './modules/uploads/message.routes';
import { uploadDir } from './modules/uploads/storage.service';
import usersRoutes from './modules/users/users.routes';
import workspacesRoutes from './modules/workspaces/workspaces.routes';

const allowedOrigins = [APP_URL, 'http://localhost:5173'];

export const app = express();

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

app.use('/api/auth', authRoutes);
app.use('/api/channels', channelsRoutes);
app.use('/api/channels', messagesRoutes);
app.use('/api/messages', messageActionsRouter);
app.use('/api/users', usersRoutes);
app.use('/api/invitations', invitationsRoutes);
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

app.post('/api/preview', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000,
    });
    const $ = cheerio.load(response.data);
    const getMetaTag = (name: string) =>
      $(`meta[property="og:${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content');
    res.json({
      title: getMetaTag('title') || $('title').text(),
      description: getMetaTag('description'),
      image: getMetaTag('image'),
      url,
    });
  } catch {
    res.json({ title: url, description: '', image: '', url });
  }
});

app.use(errorHandler);
