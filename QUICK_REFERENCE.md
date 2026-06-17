# Quick Reference Guide - Slack Clone

## 🚀 Start the Application (5 minutes)

### Terminal 1: Backend
```bash
cd backend
npm run dev
# Server running on http://localhost:4000
```

### Terminal 2: Frontend
```bash
cd frontend
npm run dev
# App running on http://localhost:5173
```

---

## 👤 Test Login Credentials

### Regular User
- **Email**: `test@example.com`
- **Password**: `password123`

### Admin User
- **Email**: `admin@slack.com`
- **Password**: `admin123`

---

## 🎯 Access Points

| What | URL | Notes |
|---|---|---|
| App | `http://localhost:5173` | Main chat interface |
| Admin Panel | `http://localhost:5173/admin` | Admin-only features |
| Backend API | `http://localhost:4000` | API endpoints |
| Health Check | `http://localhost:4000/api/health` | Database connection status |

---

## 👑 Admin Panel Features

**Navigate** → Click the admin icon or go to `/admin`

### Dashboard Tab
- Real-time user statistics
- System activity log
- Auto-refresh every 30s

### User Management Tab
- View all users with status (🟢 🔴 🟡)
- Search users
- Ban/Delete users
- View user details

### Channel Management Tab
- View ALL channels
- Create new channels
- Delete channels (except "general")
- Real-time member counts

---

## 🔧 Key Configuration Files

| File | Purpose | Key Setting |
|---|---|---|
| `backend/.env` | Backend config | `PORT=4000` |
| `frontend/vite.config.ts` | Frontend proxy | `target: 'http://localhost:4000'` |
| `backend/prisma/schema.prisma` | Database schema | User, Channel, Message models |
| `backend/seed.mjs` | Test data | Admin & test user creation |

---

## 📡 API Endpoints (Most Used)

### Authentication
```
POST /api/auth/login
POST /api/auth/register
```

### Channels
```
GET  /api/channels                 # User's channels
GET  /api/channels/admin/all       # All channels (admin)
POST /api/channels                 # Create channel
DELETE /api/channels/:id           # Delete channel (admin)
```

### Messages
```
GET /api/channels/:id/messages     # Get messages
POST /api/channels/:id/join        # Join channel
```

### Users
```
GET /api/users                     # List users (admin)
DELETE /api/users/:id              # Delete user (admin)
```

---

## 🔄 Real-Time Events (WebSocket)

### Broadcasting
- `user:online` - User connects/disconnects
- `message:received` - New message sent
- `message:updated` - Message edited
- `message:deleted` - Message removed
- `admin:channel:list:updated` - Channel created/deleted

### Status Updates
- `typing:started` - User typing indicator
- `typing:stopped` - User stopped typing
- `user:status` - User set custom status (online/away/idle)

---

## 💾 Database

**Type**: PostgreSQL  
**Connection**: Via Prisma ORM  
**Location**: `postgresql://samarthdattatraykarale@localhost:5432/slack_clone`

### Quick Commands
```bash
# Show database status
npm run db:status

# Migrate database
npm run db:migrate

# Seed test data
npm run seed

# Reset database (warning: deletes all data)
npm run db:reset
```

---

## 📋 Common Tasks

### Reset Everything to Fresh State
```bash
cd backend

# Reset database and seed
npm run db:reset

# Restart backend
npm run dev
```

### Check if Backend is Running
```bash
curl http://localhost:4000/api/health
```

### View Database Tables
```bash
cd backend
npx prisma studio
# Opens http://localhost:5555
```

### Clear All Messages from a Channel
```bash
# Use Prisma Studio: http://localhost:5555
# Navigate to messages table
# Delete by channelId
```

---

## 🐛 Troubleshooting

### "Cannot connect to backend"
- Check backend is running on port 4000
- Check frontend proxy in `frontend/vite.config.ts`
- Clear browser cache and restart frontend

### "Invalid password for all users"
- Run `npm run seed` to recreate test users
- Database might be empty after reset

### "Admin panel not accessible"
- Ensure logged in as `admin@slack.com`
- Check email contains `@admin` for admin status

### "Channels not appearing"
- Create a channel first, or run `npm run seed`
- Check WebSocket connection (browser DevTools → Network)

### "Messages not syncing in real-time"
- Verify Socket.IO connection is established
- Check browser console for errors
- Restart backend server

---

## 🎨 UI Customization

### Theme Colors
Located in `frontend/src/index.css`
- Primary Blue: `#2563EB`
- Success Green: `#10B981`
- Warning Amber: `#F59E0B`
- Danger Red: `#EF4444`

### Tailwind CSS
- Version: v4
- Custom utilities available in `index.css`
- Main config: `frontend/tailwind.config.ts`

---

## 📦 Build & Deployment

### Build Frontend
```bash
cd frontend
npm run build
# Output: dist/ folder
```

### Build Backend
```bash
cd backend
npm run build    # If available
# Or just: npm start
```

### Production Checklist
- [ ] Set `NODE_ENV=production`
- [ ] Update `APP_URL` in backend `.env`
- [ ] Update CORS origins if deploying
- [ ] Set strong `JWT_SECRET`
- [ ] Enable HTTPS
- [ ] Configure proper database connection

---

## 📞 Support Information

| Component | Port | Status |
|---|---|---|
| Frontend (Vite) | 5173 | Development server |
| Backend (Express) | 4000 | API & WebSocket |
| Database (PostgreSQL) | 5432 | Local instance |
| Prisma Studio | 5555 | Visual database editor |

---

## ✨ Recent Features (Latest Session)

✅ Professional white-theme UI  
✅ Real-time admin panel  
✅ Channel management with CRUD  
✅ User status tracking  
✅ WebSocket real-time sync  
✅ Admin authentication  
✅ Protected general channel  
✅ Database migrations aligned  
✅ Test user seeding  

---

**Last Updated**: June 17, 2026  
**Ready to Use**: YES ✅
