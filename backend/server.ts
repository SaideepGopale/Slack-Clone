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

import axios from 'axios';
import * as cheerio from 'cheerio';

import { prisma } from './lib/prisma';
import { dbCheck, errorHandler } from './middleware/index';
import authRoutes from './routes/auth';
import channelRoutes from './routes/channels';
import invitationRoutes from './routes/invitations';
import userRoutes from './routes/users';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Exiting.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const app = express();
const httpServer = createServer(app);

const allowedOrigins = [
  process.env.APP_URL || 'http://localhost:3000',
  'http://localhost:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else if (process.env.NODE_ENV !== 'production') {
      callback(null, true);
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

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/json', 'text/csv',
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-m4a'
];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = file.originalname.includes('.') ? '.' + file.originalname.split('.').pop() : '';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
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

app.get('/api/health', async (_req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl) return res.json({ database: 'missing_config', message: 'DATABASE_URL not set' });
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ database: 'connected' });
  } catch (err: any) {
    res.json({ database: 'error', message: 'Connection failed' });
  }
});

app.use('/api', dbCheck);
app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/users', userRoutes);
app.use('/api/invitations', invitationRoutes);

app.post('/api/upload', upload.single('file'), (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname, type: req.file.mimetype });
});

app.post('/api/preview', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000 
    });
    const $ = cheerio.load(response.data);
    const getMetaTag = (name: string) =>
      $(`meta[property="og:${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content');
    res.json({
      title: getMetaTag('title') || $('title').text(),
      description: getMetaTag('description'),
      image: getMetaTag('image'),
      url: url
    });
  } catch (err) { res.json({ title: url, description: '', image: '', url }); }
});

app.use(errorHandler);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication Error'));
  jwt.verify(token, JWT_SECRET as string, (err: any, decoded: any) => {
    if (err) return next(new Error('Invalid Token'));
    (socket as any).user = decoded;
    next();
  });
});

const onlineUsers = new Map<string, { id: string; username: string; status: string; emoji: string; sockets: Set<string> }>();

io.on('connection', (socket) => {
  const user = (socket as any).user as { id: string; username: string };

  if (user?.id) {
    const existing = onlineUsers.get(user.id);
    if (existing) {
      existing.sockets.add(socket.id);
    } else {
      onlineUsers.set(user.id, { id: user.id, username: user.username, status: 'active', emoji: '🟢', sockets: new Set([socket.id]) });
    }
    io.emit('user:online', Array.from(onlineUsers.values()).map(({ sockets: _s, ...u }) => u));
  }

  socket.on('channel:join', (chanId: string) => {
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(chanId);
  });

  socket.on('call:initiate', (data) => {
    socket.to(data.channelId).emit('call:incoming', {
      channelId: data.channelId,
      callerName: data.callerName,
      callType: data.callType,
      from: user.id
    });
  });

  socket.on('typing:start', (data: { channelId: string }) => {
    socket.to(data.channelId).emit('typing:started', {
      channelId: data.channelId,
      username: user.username
    });
  });

  socket.on('typing:stop', (data: { channelId: string }) => {
    socket.to(data.channelId).emit('typing:stopped', {
      channelId: data.channelId,
      username: user.username
    });
  });

  socket.on('message:send', async (data) => {
    try {
      const msg = await prisma.message.create({
        data: {
          content: data.content,
          fileUrl: data.fileUrl,
          fileName: data.fileName,
          fileType: data.fileType,
          pollData: data.pollData, // 👇 Poll ka JSON data save hoga
          channelId: data.channelId,
          senderId: user.id,
          parentId: data.parentId || null,
        },
        include: { sender: { select: { id: true, username: true } }, parent: { include: { sender: { select: { id: true, username: true } } } } },
      });
      io.to(data.channelId).emit('message:received', msg);
    } catch (err) { console.error(err); }
  });

  // 👇 NAYA: Live Vote Calculator 👇
  socket.on('poll:vote', async (data) => {
    try {
      const existing = await prisma.message.findUnique({ where: { id: data.messageId } });
      if (!existing || !existing.pollData) return;

      const pollData: any = existing.pollData;
      
      // Pehle user ka vote baaki options se hata do (taaki ek banda ek hi vote kar sake)
      pollData.options.forEach((opt: any) => {
        opt.votes = opt.votes.filter((id: string) => id !== user.id);
      });

      // Ab naye option mein user id add kar do
      const selectedOption = pollData.options.find((opt: any) => opt.id === data.optionId);
      if (selectedOption) {
        selectedOption.votes.push(user.id);
      }

      const updated = await prisma.message.update({
        where: { id: data.messageId },
        data: { pollData },
        include: { sender: { select: { username: true } } },
      });
      
      // Update saare screens par broadcast kar do!
      io.to(updated.channelId).emit('message:updated', updated);
    } catch (err) { console.error(err); }
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
    } catch (err) { console.error(err); }
  });

  socket.on('message:delete', async (data) => {
    try {
      const existing = await prisma.message.findUnique({ where: { id: data.id } });
      if (!existing || existing.senderId !== user.id) return;
      await prisma.message.delete({ where: { id: data.id } });
      io.to(existing.channelId).emit('message:deleted', data.id);
    } catch (err) { console.error(err); }
  });

  socket.on('user:status', (data: { status: string; emoji: string }) => {
    const existing = onlineUsers.get(user.id);
    if (existing) {
      existing.status = data.status;
      existing.emoji = data.emoji;
      io.emit('user:online', Array.from(onlineUsers.values()).map(({ sockets: _s, ...u }) => u));
    }
  });

  socket.on('message:pin', async (data) => {
    const updated = await prisma.message.update({
      where: { id: data.id },
      data: { isPinned: data.isPinned },
      include: { sender: { select: { username: true } } },
    });
    io.to(updated.channelId).emit('message:updated', updated);
  });

  socket.on('disconnect', () => {
    if (user?.id) {
      const existing = onlineUsers.get(user.id);
      if (existing) {
        existing.sockets.delete(socket.id);
        if (existing.sockets.size === 0) onlineUsers.delete(user.id);
      }
      io.emit('user:online', Array.from(onlineUsers.values()).map(({ sockets: _s, ...u }) => u));
    }
  });

  // 👇 ADMIN: Real-time channel events
  socket.on('admin:channel:created', async (data: { name: string; description?: string }) => {
    try {
      const channel = await prisma.channel.create({
        data: {
          name: data.name,
          description: data.description || null,
          createdBy: user.id
        }
      });
      // Broadcast to ALL connected clients
      io.emit('admin:channel:list:updated', { action: 'created', channel });
    } catch (err) {
      console.error('Failed to create channel:', err);
    }
  });

  socket.on('admin:channel:deleted', async (channelId: string) => {
    try {
      if (channelId.toLowerCase() === 'general') {
        socket.emit('error', 'Cannot delete general channel');
        return;
      }
      
      await prisma.channel.delete({ where: { id: channelId } });
      // Broadcast to ALL connected clients
      io.emit('admin:channel:list:updated', { action: 'deleted', channelId });
    } catch (err) {
      console.error('Failed to delete channel:', err);
      socket.emit('error', 'Failed to delete channel');
    }
  });

  socket.on('admin:refresh:channels', async () => {
    try {
      const channels = await prisma.channel.findMany({
        where: { isDM: false },
        include: {
          members: {
            include: {
              user: { select: { id: true, username: true } }
            }
          }
        }
      });
      socket.emit('admin:channels:list', channels);
    } catch (err) {
      console.error('Failed to refresh channels:', err);
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});