#!/usr/bin/env bash
# Throwaway load-test environment for the FUDISLTE API (docs/architecture/load-testing.md).
# Never touches the development database: every scenario gets a fresh database
# fudislte_load, a freshly started API on 127.0.0.1:8091 and is removed afterwards.
#   wsl -d Ubuntu-24.04 -- bash scripts/ops/loadtest.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/ops/lib.sh
. "$here/lib.sh"

usage() {
  cat <<'EOF'
usage: loadtest.sh [options]

For each scenario USERS:POSTERS:RATE it
  1. creates database fudislte_load on the local PostgreSQL (dropping an old one),
  2. starts the API built from services/api (go build, into /tmp) on 127.0.0.1:8091 with
     FUDISLTE_ENV=development and the log mail transport,
  3. completes first-run setup through the API, the code read from the API log,
  4. adds USERS members with sessions in SQL (tools/loadtest seed-sql); the default
     channel trigger makes every one of them a member of the default channel,
  5. runs tools/loadtest run: USERS live event streams, POSTERS of them posting RATE
     messages per second in total to the default channel for the duration,
  6. stops the API and drops fudislte_load.

options:
  --scenario U:P:R   users, posters and messages per second; repeatable
                     (default: 50:10:10, 200:20:20 and 200:50:100)
  --duration D       posting time per scenario (default 60s)
  --ramp D           open the event streams over this time (default 5s; 0s = all at
                     once, like every client reconnecting after a restart)
  --port PORT        API port on 127.0.0.1 (default 8091)
  --out DIR          where results go (default /tmp/fudislte-loadtest-results)
  --keep             keep the API logs, binaries and session tokens in /tmp/fudislte-loadtest
  -h, --help         show this help

PostgreSQL must accept fudislte/fudislte on localhost:5432 (scripts/wsl/provision.sh); the
role needs CREATEDB.
EOF
}

scenarios=() duration=60s ramp=5s port=8091 out=/tmp/fudislte-loadtest-results keep=false
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --keep)
      keep=true
      shift
      continue
      ;;
  esac
  [ $# -ge 2 ] || die "$1 needs a value (see --help)"
  case "$1" in
    --scenario) scenarios+=("$2") ;;
    --duration) duration="$2" ;;
    --ramp) ramp="$2" ;;
    --port) port="$2" ;;
    --out) out="$2" ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift 2
done
[ ${#scenarios[@]} -gt 0 ] || scenarios=(50:10:10 200:20:20 200:50:100)
for s in "${scenarios[@]}"; do
  [[ "$s" =~ ^[0-9]+:[0-9]+:[0-9]+(\.[0-9]+)?$ ]] || die "scenario must be USERS:POSTERS:RATE, got $s"
done
[[ "$port" =~ ^[0-9]+$ ]] && [ "$port" != 8080 ] || die "invalid --port (8080 is the development API)"

export PATH="$PATH:/usr/local/go/bin"
export GOCACHE="${GOCACHE:-$HOME/.cache/go-build}" GOFLAGS=-mod=readonly
need go
need psql
need curl
need ss

db=fudislte_load
pg_admin=(psql -X -q -v ON_ERROR_STOP=1 -h localhost -U fudislte -d postgres)
pg_load=(psql -X -q -v ON_ERROR_STOP=1 -h localhost -U fudislte -d "$db")
export PGPASSWORD=fudislte # the local development role from scripts/wsl/provision.sh
pg_isready -q -h localhost || die "PostgreSQL is not running on localhost:5432"
if ss -ltnH "sport = :$port" | grep -q .; then
  die "port $port is already in use"
fi

umask 077
state=/tmp/fudislte-loadtest
rm -rf "$state"
mkdir -p "$state/data" "$out"
api_pid=""
cleanup() {
  local rc=$?
  if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
    kill -TERM "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  "${pg_admin[@]}" -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true
  if $keep; then
    log "kept $state (API logs and session tokens of the throwaway database)"
  else
    rm -rf "$state"
  fi
  exit "$rc"
}
trap cleanup EXIT
ulimit -n 65536 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true

log "building the API (services/api) and tools/loadtest"
(cd "$repo/services/api" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=loadtest" \
  -o "$state/fudislte-api" ./cmd/fudislte-api)
(cd "$repo/tools/loadtest" && CGO_ENABLED=0 go build -trimpath -o "$state/loadtest" .)

{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "cpu: $(lscpu | sed -n 's/^Model name: *//p') ($(nproc) logical CPUs visible)"
  echo "memory: $(free -m | awk '/^Mem:/ { print $2 " MiB" }'), swap $(free -m | awk '/^Swap:/ { print $2 " MiB" }')"
  echo "kernel: $(uname -r)"
  echo "go: $(go version | cut -d ' ' -f 3-)"
  echo "postgres: $("${pg_admin[@]}" -Atc 'SHOW server_version'), max_connections $("${pg_admin[@]}" -Atc 'SHOW max_connections'), shared_buffers $("${pg_admin[@]}" -Atc 'SHOW shared_buffers')"
  echo "ulimit -n: $(ulimit -n)"
} | tee "$out/machine.txt" >&2

# start_api LOG starts the API in the background with only the settings below (nothing
# inherited from the shell, so no personal dev.env or LiveKit keys). Both exec calls
# replace their process, so $! is the API itself: measured by the run, stopped at the end.
start_api() {
  (
    exec env -i PATH=/usr/bin:/bin HOME="$state" \
      FUDISLTE_ENV=development \
      FUDISLTE_MAIL_TRANSPORT=log \
      FUDISLTE_DATABASE_URL="postgres://fudislte:fudislte@localhost:5432/$db?sslmode=disable" \
      FUDISLTE_HTTP_ADDR="127.0.0.1:$port" \
      FUDISLTE_PUBLIC_URL="http://localhost:$port" \
      FUDISLTE_COOKIE_SECURE=false \
      FUDISLTE_DATA_DIR="$state/data" \
      FUDISLTE_LOG_FORMAT=json \
      FUDISLTE_LOG_LEVEL=info \
      "$state/fudislte-api" serve
  ) >"$1" 2>&1 &
  api_pid=$!
}

base="http://127.0.0.1:$port"
for s in "${scenarios[@]}"; do
  IFS=: read -r users posters rate <<<"$s"
  label="${users}u-${posters}p-${rate}mps"
  [ "$ramp" != 0s ] && [ "$ramp" != 0 ] || label="$label-burst"
  log "=== scenario $label: $users streams, $posters posters, $rate msg/s for $duration"

  "${pg_admin[@]}" -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db OWNER fudislte"
  rm -rf "$state/data" && mkdir -p "$state/data"
  log "starting the API on $base"
  start_api "$state/api-$label.log"
  for _ in $(seq 1 120); do
    curl -fsS --max-time 2 "$base/healthz" >/dev/null 2>&1 && break
    kill -0 "$api_pid" 2>/dev/null || die "the API exited; see $state/api-$label.log"
    sleep 0.5
  done
  curl -fsS --max-time 2 "$base/healthz" >/dev/null || die "the API did not become healthy"
  [ "$(readlink "/proc/$api_pid/exe")" = "$state/fudislte-api" ] || die "process $api_pid is not the API"

  # First-run setup, like an operator: setup token and emailed code from the API log.
  FUDISLTE_LOADTEST_SETUP_TOKEN="$(grep -oE '"setup_token":"[A-Za-z0-9_-]+"' "$state/api-$label.log" | tail -n 1 | cut -d '"' -f 4)"
  [ -n "$FUDISLTE_LOADTEST_SETUP_TOKEN" ] || die "no setup token in the API log"
  export FUDISLTE_LOADTEST_SETUP_TOKEN
  owner=owner@loadtest.example
  "$state/loadtest" setup-code -base "$base" -email "$owner"
  FUDISLTE_LOADTEST_SETUP_CODE=""
  for _ in $(seq 1 50); do
    FUDISLTE_LOADTEST_SETUP_CODE="$(grep 'development email' "$state/api-$label.log" | grep -F "$owner" |
      grep -oE '    [0-9]{4} [0-9]{4}' | tail -n 1 | tr -d ' ' || true)"
    [ -n "$FUDISLTE_LOADTEST_SETUP_CODE" ] && break
    sleep 0.2
  done
  [ -n "$FUDISLTE_LOADTEST_SETUP_CODE" ] || die "no setup code in the API log"
  export FUDISLTE_LOADTEST_SETUP_CODE
  org_id="$("$state/loadtest" setup -base "$base" -email "$owner" -out "$state/owner.tsv" | sed -n 's/^org_id=//p')"
  unset FUDISLTE_LOADTEST_SETUP_TOKEN FUDISLTE_LOADTEST_SETUP_CODE
  [ -n "$org_id" ] || die "setup returned no workspace"

  log "adding $users members with sessions"
  rm -f "$state/members.tsv"
  "$state/loadtest" seed-sql -org "$org_id" -users "$users" -sql "$state/seed.sql" -tokens "$state/members.tsv" >/dev/null
  "${pg_load[@]}" -f "$state/seed.sql"
  in_channel="$("${pg_load[@]}" -Atc "SELECT count(*) FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE c.is_default")"
  [ "$in_channel" = $((users + 1)) ] || die "default channel has $in_channel members, expected $((users + 1))"
  schema="$("${pg_load[@]}" -Atc 'SELECT max(version_id) FROM goose_db_version WHERE is_applied')"
  log "workspace ready: $in_channel members in the default channel, schema version $schema"

  "$state/loadtest" run -base "$base" -org "$org_id" -tokens "$state/members.tsv" -users "$users" -posters "$posters" \
    -rate "$rate" -duration "$duration" -ramp "$ramp" -api-pid "$api_pid" -label "$label" -json "$out/$label.json" | tee "$out/$label.txt"
  {
    echo "schema version: $schema"
    echo "messages in the database: $("${pg_load[@]}" -Atc 'SELECT count(*) FROM messages')"
    echo "API log: $(grep -c '"http request"' "$state/api-$label.log") requests logged, $(grep -c '"level":"ERROR"' "$state/api-$label.log" || true) errors"
  } | tee -a "$out/$label.txt"

  kill -TERM "$api_pid"
  wait "$api_pid" 2>/dev/null || true
  api_pid=""
  "${pg_admin[@]}" -c "DROP DATABASE $db WITH (FORCE)"
done
log "results in $out"
