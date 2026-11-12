#!/usr/bin/env bash
# T.33 — runs the staged k6 load test against N local backend instances that
# share one Postgres database and one Redis (a load balancer with sticky
# sessions is simulated by k6 pinning each virtual user to one instance).
#
# Everything is local and disposable. Required environment:
#   LOAD_DATABASE_URL   postgresql://…@localhost:…/<db containing "load">  (seeded by loadtest/seed.ts)
#   LOAD_REDIS_URL      redis://127.0.0.1:<port>/<db>   (omit for single-instance memory mode)
#   LOAD_JWT_SECRET_FILE  file holding the JWT secret the seed used
#   LOAD_SESSIONS       sessions JSON written by the seed
#   LOAD_OUT            output directory
# Optional: NODE_FLAGS (e.g. --cpu-prof --cpu-prof-dir=DIR), INSTANCES (default 2), BASE_PORT (4401), DB_POOL (10 per instance),
#   PSQL (psql binary), PG_ADMIN_URL (postgresql://…@localhost:port, for the probe), K6 (k6 binary), STAGES (JSON)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/.." && pwd)"
INSTANCES="${INSTANCES:-2}"
BASE_PORT="${BASE_PORT:-4401}"
DB_POOL="${DB_POOL:-10}"
K6="${K6:-k6}"
PSQL="${PSQL:-psql}"
mkdir -p "$LOAD_OUT"

case "$LOAD_DATABASE_URL" in
  *localhost*load*|*127.0.0.1*load*) ;;
  *) echo "Refusing: LOAD_DATABASE_URL must be a localhost database whose name contains 'load'." >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"   # empty cwd: no .env is loaded into the instances
PIDS=()
URLS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill -TERM "$pid" 2>/dev/null || true; done
  sleep 3
  for pid in "${PIDS[@]:-}"; do kill -KILL "$pid" 2>/dev/null || true; done
  [ -n "${PROBE_PID:-}" ] && kill -TERM "$PROBE_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

LOADER="file://$BACKEND/node_modules/tsx/dist/loader.mjs"
for i in $(seq 0 $((INSTANCES - 1))); do
  PORT=$((BASE_PORT + i))
  (
    cd "$WORK"
    exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV="${APP_NODE_ENV:-production}" PORT="$PORT" APP_URL=http://localhost:5199 \
      DATABASE_URL="$LOAD_DATABASE_URL" DATABASE_CONNECTION_LIMIT="$DB_POOL" DATABASE_POOL_TIMEOUT=10 \
      JWT_SECRET="$(cat "$LOAD_JWT_SECRET_FILE")" \
      CLOUDINARY_CLOUD_NAME=load-test CLOUDINARY_API_KEY=load-test CLOUDINARY_API_SECRET=load-test \
      ${LOAD_REDIS_URL:+REDIS_URL="$LOAD_REDIS_URL"} \
      node ${NODE_FLAGS:-} --import "$LOADER" "$BACKEND/server.ts"
  ) >"$LOAD_OUT/instance-$i.log" 2>&1 &
  PIDS+=($!)
  URLS+=("http://127.0.0.1:$PORT")
done

for url in "${URLS[@]}"; do
  for _ in $(seq 1 120); do
    if curl -fsS "$url/api/ready" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  curl -fsS "$url/api/ready" >"$LOAD_OUT/ready-$(echo "$url" | sed 's/.*://').json"
done
echo "instances ready: ${URLS[*]} (pids ${PIDS[*]})"

if [ -n "${PG_ADMIN_URL:-}" ]; then
  DBNAME="$(echo "$LOAD_DATABASE_URL" | sed -E 's#.*/([^/?]+).*#\1#')"
  node "$HERE/probe.mjs" "$(IFS=,; echo "${PIDS[*]}")" "${LOAD_REDIS_URL:-redis://127.0.0.1:1/0}" "$PSQL" "$PG_ADMIN_URL" "$DBNAME" 2000 >"$LOAD_OUT/probe.csv" 2>"$LOAD_OUT/probe.err" &
  PROBE_PID=$!
fi

[ -n "${STAGES:-}" ] && export STAGES
BASE_URLS="$(IFS=,; echo "${URLS[*]}")" SESSIONS="$LOAD_SESSIONS" \
  "$K6" run --quiet --summary-export "$LOAD_OUT/summary.json" "$HERE/chat.k6.js" >"$LOAD_OUT/k6.txt" 2>&1 || echo "k6 exited with $? (thresholds may have failed)"

# Errors the instances logged during the run (no request bodies or tokens are logged).
grep -iE "error|unhandled|uncaught" "$LOAD_OUT"/instance-*.log | grep -v "prisma:query" | head -50 >"$LOAD_OUT/instance-errors.txt" || true
echo "done: $LOAD_OUT"
