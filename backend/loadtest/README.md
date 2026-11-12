# Load testing (T.33)

Local, disposable, honest: two (or more) backend instances on one machine,
sharing one Postgres database and one Redis, driven by k6 with up to 500
virtual users. Never point any of this at a real database.

## What one virtual user does (`chat.k6.js`)

- signs in with a pre-issued session (no password logins — the per-IP login
  limiter would otherwise be the only thing measured);
- loads `/api/auth/me` and the channel list, opens one Socket.IO connection
  (raw Engine.IO v4 frames over a WebSocket) and keeps it ~60 s, then
  reconnects;
- sends a chat message every ~20 s (with acknowledgement) to one of its
  channels (~25 members each) and records when other members receive it;
- every ~30 s loads 50 messages of history and the project board or "my tasks".

Virtual users alternate between instances (sticky, like a load balancer with
session affinity).

## Running

```sh
# 1. an isolated database (name must contain "load") with all migrations
createdb -h localhost -p 55448 -U test ovn_load
DATABASE_URL=postgresql://test@localhost:55448/ovn_load npx prisma migrate deploy
# 2. seed 500 people (5 workspaces × 100, 9 channels each, history, tasks) + sessions
openssl rand -hex 32 > /tmp/load/jwt.secret
DATABASE_URL=postgresql://test@localhost:55448/ovn_load JWT_SECRET="$(cat /tmp/load/jwt.secret)" \
  CLOUDINARY_CLOUD_NAME=x CLOUDINARY_API_KEY=x CLOUDINARY_API_SECRET=x \
  npx tsx loadtest/seed.ts 500 /tmp/load/sessions.json
# 3. a throwaway Redis
docker run -d --name load-redis -p 127.0.0.1:56379:6379 redis:7.2-alpine --save "" --appendonly no
# 4. run (stages: 50 → 100 → 250 → 500 VUs, hold, ramp down; ~9 min)
LOAD_DATABASE_URL=postgresql://test@localhost:55448/ovn_load LOAD_REDIS_URL=redis://127.0.0.1:56379/13 \
LOAD_JWT_SECRET_FILE=/tmp/load/jwt.secret LOAD_SESSIONS=/tmp/load/sessions.json LOAD_OUT=/tmp/load/run1 \
PSQL=psql PG_ADMIN_URL=postgresql://test@localhost:55448 K6=k6 ./loadtest/run.sh
```

Outputs in `LOAD_OUT`: `k6.txt` and `summary.json` (latency percentiles,
throughput, errors, socket metrics), `probe.csv` (per-instance CPU and RSS,
Postgres connections, Redis round-trip and ops/s every 2 s),
`instance-*.log`, `instance-errors.txt`.

Leave `LOAD_REDIS_URL` unset with `INSTANCES=1` for the single-instance,
in-memory baseline.

## Reading the numbers

The load generator, both instances, Postgres and Redis share one machine, so
results are a lower bound of what separate hosts would sustain, and CPU is
contended by k6 itself. Results of the T.33 run are recorded in
`entireanalysis.md` (T.33 section).
