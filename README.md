# Slick — Smart Chat App

A real-time chat application built with React + Vite (frontend) and Node.js + Express + Socket.IO (backend), backed by PostgreSQL via Prisma.

## Project Structure

```
Smart_chat_app/
├── frontend/               # React + Vite + Tailwind CSS
│   ├── src/
│   │   ├── components/     # UI components (auth, chat, layout, sidebar)
│   │   ├── contexts/       # React contexts (AuthContext)
│   │   ├── hooks/          # Custom hooks (useSocket)
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── types.ts
│   │   └── index.css
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   └── .env.example
│
├── backend/                # Node.js + Express + Socket.IO
│   ├── routes/             # Express route handlers
│   ├── middleware/         # Auth middleware, error handler
│   ├── lib/                # Prisma client singleton
│   ├── utils/              # Mailer utility
│   ├── prisma/             # Prisma schema and migrations
│   ├── uploads/            # Uploaded files (gitignored)
│   ├── server.ts           # Main server entry point
│   ├── tsconfig.json
│   ├── package.json
│   └── .env.example
│
├── .gitignore
└── README.md
```

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL database (local or cloud — Neon, Supabase, etc.)

### Backend Setup

```bash
cd backend
npm install

# Copy and fill in environment variables
cp .env.example .env

# Run database migrations
npm run db:migrate

# Start the development server (port 3000)
npm run dev
```

### Frontend Setup

```bash
cd frontend
npm install

# Copy and fill in environment variables (EmailJS keys)
cp .env.example .env

# Start the Vite dev server (port 5173)
npm run dev
```

The frontend dev server proxies `/api` and `/uploads` requests to `http://localhost:3000`.

### Environment Variables

**Backend** (`backend/.env`):
| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing JWTs (use a long random string) |
| `APP_URL` | App URL for CORS and invite links |
| `PORT` | Server port (default: 3000) |
| `EMAIL_USER` | Gmail address for sending invites |
| `EMAIL_PASS` | Gmail app password |

**Frontend** (`frontend/.env`):
| Variable | Description |
|---|---|
| `VITE_EMAILJS_SERVICE_ID` | EmailJS service ID |
| `VITE_EMAILJS_TEMPLATE_ID` | EmailJS template ID |
| `VITE_EMAILJS_PUBLIC_KEY` | EmailJS public key |

## Features

- Real-time messaging with Socket.IO
- Channel-based and direct message conversations
- File uploads (images, PDFs, documents)
- Message editing, deletion, and reactions
- WebRTC audio/video calls with screen sharing
- User mentions and emoji picker
- JWT authentication
- Email invitations
- Online presence indicators
