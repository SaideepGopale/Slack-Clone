import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import multer from 'multer';

// Internal Imports
import authRoutes from './backend/routes/auth.ts';
import channelRoutes from './backend/routes/channels.ts';
import userRoutes from './backend/routes/users.ts';
import invitationRoutes from './backend/routes/invitations.ts';
import { dbCheck, errorHandler } from './backend/middleware/index.ts';
import { prisma } from './backend/lib/prisma.ts';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Uploads setup
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { 
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key-456';

// Multer
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

// Routes
app.get('/api/health', async (req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  const maskedUrl = dbUrl.replace(/:.+@/, ':****@');
  console.log('Health check - DB URL:', maskedUrl);

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
      details: err.message
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
    type: req.file.mimetype 
  });
});

app.use(errorHandler);

// Socket Logic
io.use((socket, next) => {
  let token = socket.handshake.auth?.token;
  
  if (!token || token === 'null' || token === 'undefined') {
    console.warn(`Socket Auth: No valid token provided from ${socket.id}`);
    return next(new Error('Authentication Error: Missing Token'));
  }

  jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
    if (err) {
      console.error(`Socket Auth: JWT verification failed for ${socket.id}:`, err.message);
      return next(new Error('Authentication Error: Invalid or Expired Token'));
    }
    (socket as any).user = decoded;
    next();
  });
});

const onlineUsers = new Map<string, { id: string, username: string, email: string, sockets: Set<string> }>();

io.on('connection', (socket) => {
  const user = (socket as any).user;
  
  if (user && user.id) {
    const existing = onlineUsers.get(user.id);
    if (existing) {
      existing.sockets.add(socket.id);
    } else {
      onlineUsers.set(user.id, { 
        ...user, 
        sockets: new Set([socket.id]) 
      });
    }
    
    // Convert to array for emission, omitting sockets set
    const emitUsers = Array.from(onlineUsers.values()).map(({ sockets, ...u }) => u);
    io.emit('user:online', emitUsers);
  }

  socket.on('channel:join', (chanId) => {
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
          parentId: data.parentId
        },
        include: {
          sender: {
            select: { username: true }
          },
          parent: {
            include: {
              sender: {
                select: { username: true }
              }
            }
          }
        }
      });
      io.to(data.channelId).emit('message:received', msg);
    } catch (err) {
      console.error('Failed to save message:', err);
    }
  });

  socket.on('message:edit', async (data) => {
    try {
      const existing = await prisma.message.findUnique({
        where: { id: data.id }
      });
      
      if (!existing || existing.senderId !== user.id) {
        return;
      }

      const updated = await prisma.message.update({
        where: { id: data.id },
        data: { content: data.content },
        include: {
          sender: {
            select: { username: true }
          }
        }
      });
      io.to(updated.channelId).emit('message:updated', updated);
    } catch (err) {
      console.error('Failed to edit message:', err);
    }
  });

  socket.on('message:delete', async (data) => {
    try {
      const existing = await prisma.message.findUnique({
        where: { id: data.id }
      });
      
      if (!existing || existing.senderId !== user.id) {
        return;
      }

      await prisma.message.delete({
        where: { id: data.id }
      });
      io.to(existing.channelId).emit('message:deleted', data.id);
    } catch (err) {
      console.error('Failed to delete message:', err);
    }
  });

  socket.on('disconnect', () => {
    if (user && user.id) {
      const existing = onlineUsers.get(user.id);
      if (existing) {
        existing.sockets.delete(socket.id);
        if (existing.sockets.size === 0) {
          onlineUsers.delete(user.id);
        }
      }
      const emitUsers = Array.from(onlineUsers.values()).map(({ sockets, ...u }) => u);
      io.emit('user:online', emitUsers);
    }
  });
});

// Vite
(async () => {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (_, res) => res.sendFile(path.resolve(__dirname, 'dist', 'index.html')));
  }
  httpServer.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));
})();
