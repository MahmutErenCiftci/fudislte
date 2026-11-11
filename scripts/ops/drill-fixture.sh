#!/usr/bin/env bash
# Throwaway FUDISLTE deployment with realistic content, for restore drills when the real
# deployment on the host holds no data (or must not be used).
#   bash scripts/ops/drill-fixture.sh up      create and fill project fudislte-drillsrc
#   bash scripts/ops/drill-fixture.sh drill   run restore-drill.sh with it as the source
#   bash scripts/ops/drill-fixture.sh down    remove it (docker compose down -v)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/ops/lib.sh
. "$here/lib.sh"

usage() {
  cat <<'EOF'
usage: drill-fixture.sh up|drill|down [--project NAME] [--members N] [--messages N] [--files N]

up     creates Compose project fudislte-drillsrc from infrastructure/docker/compose.yml and
       scripts/ops/compose.drill.yml (no published ports, own networks and volumes),
       running the images of the fudislte-local stack, or FUDISLTE_FIXTURE_{POSTGRES,API,WEB}_IMAGE.
       It completes first-run setup through the real API (setup token and emailed code
       read from the API log), adds members with sessions in SQL (tools/loadtest seed-sql)
       and fills the workspace through the API (tools/loadtest populate): channels,
       messages, thread replies, mentions, reactions, an edit, a pin, a deletion,
       attachments (one never sent) and a direct conversation.
drill  runs restore-drill.sh with this project as the source (extra options are passed on)
down   removes the project with docker compose down -v and its state in /tmp

Needs Go (/usr/local/go/bin) to build tools/loadtest, and a Docker host whose container
addresses are reachable from the host itself (Linux, WSL).
EOF
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  -h | --help | help)
    usage
    exit 0
    ;;
esac
project=fudislte-drillsrc members=8 messages=150 nfiles=6
passthrough=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --project | --members | --messages | --files)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --project) project="$2" ;;
        --members) members="$2" ;;
        --messages) messages="$2" ;;
        --files) nfiles="$2" ;;
      esac
      shift 2
      ;;
    *)
      passthrough+=("$1")
      shift
      ;;
  esac
done
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "invalid project name"
case "$project" in fudislte | fudislte-local | fudislte-drill) die "refusing to use $project for the fixture" ;; esac

# Per user, not in /tmp, where another user could create the directory first.
state_root="${XDG_RUNTIME_DIR:-$HOME/.cache}/fudislte"
mkdir -p "$state_root" && chmod 700 "$state_root"
state="$state_root/$project"
compose_dir="$repo/infrastructure/docker"
files=("$compose_dir/compose.yml" "$here/compose.drill.yml")
compose_cmd F "$compose_dir" "$project" "$state/drill.env" "${files[@]}"
unset COMPOSE_PROFILES COMPOSE_FILE COMPOSE_PROJECT_NAME

image_from_local() { # SERVICE FALLBACK: the image ID fudislte-local runs, if it runs
  local cid
  cid="$(docker ps -q --filter label=com.docker.compose.project=fudislte-local --filter "label=com.docker.compose.service=$1" | head -n 1)"
  if [ -n "$cid" ]; then docker inspect -f '{{.Image}}' "$cid"; else echo "$2"; fi
}

case "$cmd" in
  up)
    need docker
    need curl
    project_exists "$project" && die "project $project exists; run: $0 down"
    [ ! -e "$state" ] || die "$state exists; run: $0 down"
    umask 077
    mkdir -p "$state"
    cat >"$state/drill.env" <<EOF
COMPOSE_PROFILES=
FUDISLTE_DOMAIN=fixture.invalid
POSTGRES_PASSWORD=$(random_secret)
FUDISLTE_DRILL_POSTGRES_IMAGE=${FUDISLTE_FIXTURE_POSTGRES_IMAGE:-$(image_from_local postgres postgres:17-alpine)}
FUDISLTE_DRILL_API_IMAGE=${FUDISLTE_FIXTURE_API_IMAGE:-$(image_from_local api fudislte/api:0.1.1)}
FUDISLTE_DRILL_WEB_IMAGE=${FUDISLTE_FIXTURE_WEB_IMAGE:-$(image_from_local web fudislte/web:0.1.1)}
FUDISLTE_DRILL_EDGE_SUBNET=$(free_subnet)
EOF
    log "starting project $project"
    run_compose F up -d --wait --wait-timeout 180

    log "building tools/loadtest"
    (cd "$repo/tools/loadtest" && GOCACHE="${GOCACHE:-$HOME/.cache/go-build}" PATH="$PATH:/usr/local/go/bin" \
      go build -o "$state/loadtest" .)
    web_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${project}_edge\").IPAddress}}" \
      "$(run_compose F ps -q web | head -n 1)")"
    base="http://$web_ip:8088"
    curl -fsS --max-time 10 "$base/api/v1/meta" >/dev/null || die "cannot reach $base from this host"

    log "first-run setup through the API at $base"
    for _ in $(seq 1 30); do
      FUDISLTE_LOADTEST_SETUP_TOKEN="$(run_compose F logs --no-color api 2>/dev/null |
        grep -oE '"setup_token":"[A-Za-z0-9_-]+"' | tail -n 1 | cut -d '"' -f 4 || true)"
      [ -n "$FUDISLTE_LOADTEST_SETUP_TOKEN" ] && break
      sleep 1
    done
    [ -n "$FUDISLTE_LOADTEST_SETUP_TOKEN" ] || die "no setup token in the API log"
    export FUDISLTE_LOADTEST_SETUP_TOKEN
    owner=owner@fixture.example
    "$state/loadtest" setup-code -base "$base" -email "$owner"
    for _ in $(seq 1 30); do
      FUDISLTE_LOADTEST_SETUP_CODE="$(run_compose F logs --no-color api 2>/dev/null | grep 'development email' |
        grep -F "$owner" | grep -oE '    [0-9]{4} [0-9]{4}' | tail -n 1 | tr -d ' ' || true)"
      [ -n "$FUDISLTE_LOADTEST_SETUP_CODE" ] && break
      sleep 1
    done
    [ -n "$FUDISLTE_LOADTEST_SETUP_CODE" ] || die "no setup code in the API log"
    export FUDISLTE_LOADTEST_SETUP_CODE
    org_id="$("$state/loadtest" setup -base "$base" -email "$owner" -name "Tatbikat Sahibi" -org "Tatbikat A.Ş." \
      -out "$state/owner.tsv" | sed -n 's/^org_id=//p')"
    unset FUDISLTE_LOADTEST_SETUP_TOKEN FUDISLTE_LOADTEST_SETUP_CODE

    log "adding $members members with sessions (SQL)"
    "$state/loadtest" seed-sql -org "$org_id" -users "$members" -prefix uye -domain fixture.example \
      -sql "$state/seed.sql" -tokens "$state/members.tsv" >/dev/null
    run_compose F exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$FUDISLTE_DB_USER" -d "$FUDISLTE_DB_NAME" <"$state/seed.sql"

    log "filling the workspace through the API"
    "$state/loadtest" populate -base "$base" -org "$org_id" -tokens "$state/members.tsv" \
      -messages "$messages" -files "$nfiles"
    log "project $project is ready; row counts:"
    table_counts F | sed 's/^/    /' >&2
    ;;
  drill)
    [ -f "$state/drill.env" ] || die "no fixture; run: $0 up"
    bash "$here/restore-drill.sh" --source-project "$project" --source-dir "$compose_dir" \
      --source-file compose.yml --source-file "$here/compose.drill.yml" --source-env-file "$state/drill.env" \
      "${passthrough[@]}"
    ;;
  down)
    if [ ! -f "$state/drill.env" ]; then
      # Values only satisfy compose.yml's required variables; nothing is started.
      mkdir -p "$state"
      printf 'FUDISLTE_DOMAIN=x\nPOSTGRES_PASSWORD=x\nFUDISLTE_DRILL_POSTGRES_IMAGE=x\nFUDISLTE_DRILL_API_IMAGE=x\nFUDISLTE_DRILL_WEB_IMAGE=x\nFUDISLTE_DRILL_EDGE_SUBNET=172.29.255.0/24\n' >"$state/drill.env"
    fi
    run_compose F down -v --remove-orphans
    rm -rf "$state"
    log "removed project $project"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
