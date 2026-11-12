# SmartConnect Collab

Team messaging and collaboration: workspaces and organizations, public and
private channels, direct and group messages, threads, reactions, pins, polls,
search, notifications, private file sharing, and browser audio/video calls
with screen sharing — plus an administration console for Company Admins and
Team Leads.

## Architecture

| Part | Technology | Where |
|---|---|---|
| Web app | React 19, Vite 6, Tailwind CSS 4, react-router 7 | `frontend/` |
| API + real time | Node.js 22, Express 4, TypeScript (run with `tsx`), Socket.IO 4 | `backend/` |
| Database | PostgreSQL 16 via Prisma 6 (one schema, migrations in `backend/prisma/migrations`) | `backend/prisma/` |
| Files | Cloudinary — private (authenticated) uploads, short-lived signed links | `backend/lib/attachments.ts` |
| E-mail | Resend HTTP API | `backend/utils/mailer.ts` |
| Calls | WebRTC mesh; STUN/TURN servers come from the backend (`/api/calls/ice-servers`) | `frontend/src/components/chat/CallOverlay.tsx` |
| Deployment | Render blueprint (`render.yaml`): one web service + one static site | repository root |

One Express process serves REST and Socket.IO. Real-time state (presence,
calls, rate-limit windows) lives in that process, so run a **single instance**
until a shared Socket.IO adapter (e.g. Redis) is added.

## Local development

Prerequisites: Node.js 22.14 (see `.nvmrc`), PostgreSQL 16, a Cloudinary
account (any free account works for local uploads).

```bash
# Backend (port 3000)
cd backend
npm ci
cp .env.example .env          # fill in the values below
npx prisma migrate deploy     # applies every migration to your local database
npm run dev

# Frontend (port 5174, proxies /api to the backend)
cd frontend
npm ci
npm run dev
```

Development data (never in production): `SEED_USER_PASSWORD=… SEED_ADMIN_PASSWORD=… npx tsx seed.ts`.

### Backend environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string (Supabase: the **session** pooler, port 5432; add `connection_limit=5`) |
| `JWT_SECRET` | yes | Signs session tokens — a long random value |
| `APP_URL` | production | The frontend's public URL (CORS, Socket.IO origin, links in e-mails) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | yes | File storage |
| `RESEND_API_KEY` | for e-mail | Invitations and password resets |
| `EMAIL_FROM` | optional | Sender on a domain verified in Resend (default: Resend's test sender, which only delivers to the Resend account owner) |
| `CALL_TURN_URLS` + `CALL_TURN_SECRET` (or `CALL_TURN_USERNAME` / `CALL_TURN_CREDENTIAL`) | recommended | TURN relay so calls connect on restrictive networks |
| `CALL_STUN_URLS`, `CALL_TURN_TTL_SECONDS`, `CALL_MAX_PARTICIPANTS`, `TRUST_PROXY`, `PORT` | optional | See the comments in `backend/lib/iceServers.ts`, `backend/config/` |

### Frontend environment

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Backend URL for REST (empty = same origin / dev proxy) |
| `VITE_BACKEND_URL` | Backend URL for Socket.IO (defaults to `VITE_API_URL`) |

Both are baked in at build time.

## First Company Admin (new database)

Sign-up is invitation-only, so a new deployment needs its first administrator
created once, from a shell with access to the database:

```bash
cd backend
read -s BOOTSTRAP_ADMIN_PASSWORD && export BOOTSTRAP_ADMIN_PASSWORD   # 12+ chars, mixed
BOOTSTRAP_CONFIRM=CREATE_FIRST_COMPANY_ADMIN \
BOOTSTRAP_ADMIN_EMAIL='owner@your-company.example' \
BOOTSTRAP_ADMIN_USERNAME='owner' \
npm run admin:bootstrap
```

It refuses if any administrator already exists, never prints the password and
writes an audit entry. Everyone else is invited from the admin console.

## Tests

```bash
cd backend && DATABASE_URL=postgresql://user@localhost:5432/throwaway_db npm test   # never a real database
cd frontend && npm test
cd frontend && E2E_DATABASE_URL=postgresql://user@localhost:5432/throwaway_e2e npm run test:e2e
```

The backend suite applies migrations to the database it is given and creates
test data — point it only at a disposable local database. Add
`TEST_REDIS_URL=redis://127.0.0.1:6379/15` (a disposable local Redis — it is
flushed) to also run the Redis store tests and the multi-instance test, which
starts real server processes side by side and checks messages, presence,
revocation, calls, rate limits, crash recovery and graceful shutdown across
them.

## Deployment (Render + Supabase)

`render.yaml` defines `smartconnect-backend` (runs `prisma migrate deploy`, then
the server) and `smartconnect-frontend` (static build). Set the variables above
in the Render dashboard, run `npm run admin:bootstrap` once. Without
`REDIS_URL`, keep the backend at one instance (see Scaling). Lock down Supabase's Data API (or enable RLS) — the app
connects to Postgres directly and does not use it.

## Scaling (several backend instances)

One instance needs nothing extra. To run two or more behind a load balancer:

1. **Redis** — set the same `REDIS_URL` on every instance. It carries Socket.IO
   events between instances (Redis adapter), presence, call participants and
   rings, and every HTTP and socket rate-limit counter (one budget per user/IP
   across instances). PostgreSQL stays the only source of truth for data; if
   Redis is unreachable, rate limits fail open and `/api/ready` reports it.
2. **Load balancer** — route `/socket.io/` with WebSocket upgrade support.
   Sticky sessions are only required if long-polling is allowed (the client
   prefers WebSocket); enable them anyway (cookie or client-IP affinity) for
   robustness. Use `/api/ready` as the health check (it answers 503 while the
   instance is draining or cannot reach the database or Redis), keep the idle
   timeout above 25 s (Socket.IO pings) and below the server's 65 s keep-alive.
   Set `TRUST_PROXY` to the number of proxies in front of the app so per-IP
   limits see the real client address.
3. **Database connections** — each instance opens up to
   `DATABASE_CONNECTION_LIMIT` connections (default: Prisma's own). Keep
   instances × limit below the pooler's limit (Supabase session pooler: see
   the project's pool size), e.g. 2 instances × 10.
4. **Deploys** — instances shut down gracefully on SIGTERM: readiness turns
   503, sockets are told to reconnect (they land on another instance), open
   requests finish, then connections close (forced after
   `SHUTDOWN_TIMEOUT_MS`).

Background work is safe with several instances: overdue-task reminders claim
each task atomically (one reminder, whichever instance runs first), the
orphan-file sweep is idempotent (deleting an already-deleted file is a no-op),
and the presence sweep is guarded by a Redis lock. `backend/loadtest/` contains the k6 load test used to
measure two local instances with up to 500 simulated users.

