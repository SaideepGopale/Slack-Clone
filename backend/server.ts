import cors from 'cors';
import express from 'express';
import fs from 'fs';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import './env';

import { prisma } from './lib/prisma';
import { dbCheck, errorHandler } from './middleware/index';
import authRoutes from './routes/auth';
import channelRoutes from './routes/channels';
import invitationRoutes from './routes/invitations';
import userRoutes from './routes/users';

// Fail fast if required secrets are missing
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Exiting.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Uploads directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const app = express();
const httpServer = createServer(app);

// CORS — allow frontend dev server and production origin
const allowedOrigins = [
  process.env.APP_URL || 'http://localhost:3000',
  'http://localhost:5173', // Vite dev server
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else if (process.env.NODE_ENV !== 'production') {
      callback(null, true); // Allow all in dev
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? (process.env.APP_URL || 'http://localhost:3000')
      : '*',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

const PORT = Number(process.env.PORT) || 3000;

// Multer — file size limit and MIME type allowlist
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type "${file.mimetype}" is not allowed.`));
    }
  },
});

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir));

// Health check
app.get('/api/health', async (_req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl) {
    return res.json({ database: 'missing_config', message: 'DATABASE_URL not set' });
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ database: 'connected' });
  } catch (err: any) {
    console.error('Database connection error:', err);
    res.json({
      database: 'error',
      message: 'Connection failed',
      details: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

app.use('/api', dbCheck);
app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/users', userRoutes);
app.use('/api/invitations', invitationRoutes);

app.post('/api/upload', upload.single('file'), (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    type: req.file.mimetype,
  });
});

// In production, serve the built frontend
if (process.env.NODE_ENV === 'production') {
  const frontendDist = path.resolve(__dirname, '../frontend/dist');
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use(errorHandler);

// Socket.IO — JWT authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token || token === 'null' || token === 'undefined') {
    return next(new Error('Authentication Error: Missing Token'));
  }
  jwt.verify(token, JWT_SECRET as string, (err: any, decoded: any) => {
    if (err) {
      console.error(`Socket Auth: JWT verification failed for ${socket.id}:`, err.message);
      return next(new Error('Authentication Error: Invalid or Expired Token'));
    }
    (socket as any).user = decoded;
    next();
  });
});

const onlineUsers = new Map<string, { id: string; username: string; sockets: Set<string> }>();

io.on('connection', (socket) => {
  const user = (socket as any).user as { id: string; username: string };

  if (user?.id) {
    const existing = onlineUsers.get(user.id);
    if (existing) {
      existing.sockets.add(socket.id);
    } else {
      onlineUsers.set(user.id, { id: user.id, username: user.username, sockets: new Set([socket.id]) });
    }
    const emitUsers = Array.from(onlineUsers.values()).map(({ sockets: _s, ...u }) => u);
    io.emit('user:online', emitUsers);
  }

  socket.on('channel:join', (chanId: string) => {
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(chanId);
  });

  socket.on('message:send', async (data) => {
    try {
      const msg = await prisma.message.create({
        data: {
          content: data.content,
          fileUrl: data.fileUrl,
          fileName: data.fileName,
          fileType: data.fileType,
          channelId: data.channelId,
          senderId: user.id,
          parentId: data.parentId || null,
        },
        include: {
          sender: { select: { username: true } },
          parent: { include: { sender: { select: { username: true } } } },
        },
      });
      io.to(data.channelId).emit('message:received', msg);
    } catch (err) {
      console.error('Failed to save message:', err);
    }
  });

  socket.on('message:edit', async (data) => {
    try {
      const existing = await prisma.message.findUnique({ where: { id: data.id } });
      if (!existing || existing.senderId !== user.id) return;
      const updated = await prisma.message.update({
        where: { id: data.id },
        data: { content: data.content },
        include: { sender: { select: { username: true } } },
      });
      io.to(updated.channelId).emit('message:updated', updated);
    } catch (err) {
      console.error('Failed to edit message:', err);
    }
  });

  socket.on('message:delete', async (data) => {
    try {
      const existing = await prisma.message.findUnique({ where: { id: data.id } });
      if (!existing || existing.senderId !== user.id) return;
      await prisma.message.delete({ where: { id: data.id } });
      io.to(existing.channelId).emit('message:deleted', data.id);
    } catch (err) {
      console.error('Failed to delete message:', err);
    }
  });

  socket.on('call:start', (data) => {
    socket.to(data.channelId).emit('call:incoming', { offer: data.offer, from: user.id, type: data.type });
  });
  socket.on('call:answer', (data) => {
    socket.to(data.channelId).emit('call:answered', { answer: data.answer });
  });
  socket.on('call:ice-candidate', (data) => {
    socket.to(data.channelId).emit('call:ice-candidate', { candidate: data.candidate });
  });
  socket.on('call:end', (data) => {
    socket.to(data.channelId).emit('call:ended');
  });

  socket.on('disconnect', () => {
    if (user?.id) {
      const existing = onlineUsers.get(user.id);
      if (existing) {
        existing.sockets.delete(socket.id);
        if (existing.sockets.size === 0) onlineUsers.delete(user.id);
      }
      const emitUsers = Array.from(onlineUsers.values()).map(({ sockets: _s, ...u }) => u);
      io.emit('user:online', emitUsers);
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
