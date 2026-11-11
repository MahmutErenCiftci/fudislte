#!/usr/bin/env bash
# Restore drill: back up a running FUDISLTE deployment, restore it into a new isolated
# Compose project, verify the copy against the source, then remove the copy.
# Operator guide: docs/deployment/backup-restore.md
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/ops/lib.sh
. "$here/lib.sh"

usage() {
  cat <<'EOF'
usage: restore-drill.sh [options]

Backs up a running deployment with backup.sh, restores the backup with restore.sh into a
NEW Compose project (compose.yml + scripts/ops/compose.drill.yml: same images, its own
networks and volumes, no published ports), verifies the copy and finally runs
"docker compose -p <drill project> down -v". The source deployment is only read.

checks:
  api      the restored api container is healthy and /readyz reports the database ready
  web      Caddy in the drill network proxies /api/v1/meta to the restored API
  schema   the migration version equals the source's
  rows     row counts of the main tables equal the source's (counted after the backup)
  files    the SHA-256 list of attachment files equals the source's
  db-disk  every attachments row has its file, with the SHA-256 the database recorded
  owner    the api volume and the files belong to the same user as in the source
  serve    the restored API returns each attachment byte for byte to its uploader
           (temporary sessions created in the drill database only)

options:
  --source-project NAME    source Compose project (default: fudislte-local)
  --source-dir DIR         its compose directory (default: infrastructure/docker)
  --source-file FILE       its compose files, repeatable
                           (default: compose.yml and compose.local.yml)
  --source-env-file FILE   its env file (default: .env.local)
  --drill-project NAME     project to restore into (default: fudislte-drill); must not exist
  --work-dir DIR           where the backup goes (default: a new /tmp/fudislte-drill.*)
  --age                    encrypt the backup with a throwaway age key (needs age)
  --report FILE            also write the report to FILE
  --keep                   keep the drill project and the backup for inspection
  -h, --help               show this help
EOF
}

source_project=fudislte-local source_dir="$repo/infrastructure/docker" source_env=.env.local
drill=fudislte-drill work="" report="" keep=false use_age=false
source_files=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --keep | --age)
      [ "$1" = --keep ] && keep=true || use_age=true
      shift
      continue
      ;;
  esac
  [ $# -ge 2 ] || die "$1 needs a value (see --help)"
  case "$1" in
    --source-project) source_project="$2" ;;
    --source-dir) source_dir="$2" ;;
    --source-file) source_files+=("$2") ;;
    --source-env-file) source_env="$2" ;;
    --drill-project) drill="$2" ;;
    --work-dir) work="$2" ;;
    --report) report="$2" ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift 2
done

need docker
require_gnu_tar
[ ${#source_files[@]} -gt 0 ] || source_files=(compose.yml compose.local.yml)
source_dir="$(cd "$source_dir" && pwd)"
source_env="$(abspath "$source_env" "$source_dir")"
src_files_abs=()
for f in "${source_files[@]}"; do
  src_files_abs+=("$(abspath "$f" "$source_dir")")
done
# The drill runs the source's base compose file with the drill overlay instead of the
# source's own overrides.
drill_files=("${src_files_abs[0]}" "$here/compose.drill.yml")

[[ "$drill" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "invalid drill project name: $drill"
[ "$drill" != "$source_project" ] || die "the drill project must differ from the source project"
case "$drill" in fudislte | fudislte-local) die "refusing to use $drill as the drill project" ;; esac
project_exists "$drill" && die "project $drill already exists; remove it first: docker compose -p $drill down -v"
unset COMPOSE_PROFILES COMPOSE_FILE COMPOSE_PROJECT_NAME

compose_cmd SRC "$source_dir" "$source_project" "$source_env" "${src_files_abs[@]}"
src_pg="$(run_compose SRC ps -q postgres | head -n 1)"
src_api="$(run_compose SRC ps -q api | head -n 1)"
src_web="$(run_compose SRC ps -a -q web | head -n 1)"
[ -n "$src_pg" ] && [ -n "$src_api" ] || die "source project $source_project is not running"
[ -n "$src_web" ] || die "source project $source_project has no web container"

umask 077
if [ -z "$work" ]; then
  work="$(mktemp -d /tmp/fudislte-drill.XXXXXX)"
else
  mkdir -p "$work"
  work="$(cd "$work" && pwd)"
fi
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
t_start=$SECONDS
drill_created=false
teardown() {
  local rc=$?
  if $keep; then
    log "kept for inspection: project $drill and $work"
    log "remove with: docker compose -p $drill --project-directory $source_dir --env-file $work/drill.env -f ${drill_files[0]} -f ${drill_files[1]} down -v; rm -rf $work"
  else
    if $drill_created; then
      log "removing the drill: docker compose -p $drill down -v"
      run_compose DRILL down -v --remove-orphans >/dev/null 2>&1 || run_compose DRILL down -v --remove-orphans || true
    fi
    rm -rf "$work"
  fi
  exit "$rc"
}
trap teardown EXIT

# The drill copies the source's images exactly (by ID), so a rebuilt tag cannot sneak a
# different version into the drill.
cat >"$work/drill.env" <<EOF
COMPOSE_PROFILES=
FUDISLTE_DOMAIN=drill.invalid
POSTGRES_PASSWORD=$(random_secret)
FUDISLTE_DRILL_POSTGRES_IMAGE=$(docker inspect -f '{{.Image}}' "$src_pg")
FUDISLTE_DRILL_API_IMAGE=$(docker inspect -f '{{.Image}}' "$src_api")
FUDISLTE_DRILL_WEB_IMAGE=$(docker inspect -f '{{.Image}}' "$src_web")
FUDISLTE_DRILL_EDGE_SUBNET=$(free_subnet)
EOF
compose_cmd DRILL "$source_dir" "$drill" "$work/drill.env" "${drill_files[@]}"

age_backup=(--unencrypted) age_restore=()  # the drill's own throwaway directory
if $use_age; then
  need age-keygen
  age-keygen -o "$work/drill.agekey" 2>/dev/null
  age_backup=(-r "$(age-keygen -y "$work/drill.agekey")")
  age_restore=(-k "$work/drill.agekey")
fi

log "== 1/3 backup of $source_project"
t_backup=$SECONDS
src_file_args=()
for f in "${src_files_abs[@]}"; do
  src_file_args+=(-f "$f")
done
backup_dir="$(bash "$here/backup.sh" -p "$source_project" -d "$source_dir" "${src_file_args[@]}" -e "$source_env" \
  -o "$work/backup" --with-caddy "${age_backup[@]}")"
t_backup=$((SECONDS - t_backup))
# Reference values from the source, taken after the backup.
src_counts="$(table_counts SRC)"
src_schema="$(schema_version SRC)"
src_users="$(psql_in SRC 'SELECT count(*) FROM users')"
docker cp "$src_api:$FUDISLTE_DATA_PATH/files" - | files_sha256 >"$work/source-files.sha256"
owner_of() { # owner of the api data volume root and of its files directory
  docker run --rm --network none --volumes-from "$1:ro" --entrypoint stat "$(docker inspect -f '{{.Image}}' "$src_pg")" \
    -c '%n %u:%g %a' "$FUDISLTE_DATA_PATH" "$FUDISLTE_DATA_PATH/files"
}
src_owner="$(owner_of "$src_api")"
dump_counts="$(grep '^rows\.' "$backup_dir/MANIFEST" | sed -E 's/^rows\.([^:]+): /\1 /')"

log "== 2/3 restore into the new project $drill"
t_restore=$SECONDS
drill_created=true
bash "$here/restore.sh" -p "$drill" -d "$source_dir" -f "${drill_files[0]}" -f "${drill_files[1]}" -e "$work/drill.env" \
  -i "$backup_dir" --yes "${age_restore[@]}"
t_restore=$((SECONDS - t_restore))

log "== 3/3 verification"
d_api="$(run_compose DRILL ps -q api | head -n 1)"
results=()
failed=0
check() { # check NAME PASS|FAIL|SKIP DETAIL
  results+=("$(printf '%-8s %-5s %s' "$1" "$2" "$3")")
  [ "$2" != FAIL ] || failed=$((failed + 1))
}

health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$d_api")"
ready="$(run_compose DRILL exec -T web wget -q -T 10 -O - http://api:8080/readyz 2>&1 || true)"
if [ "$health" = healthy ] && [[ "$ready" == *'"ready"'* ]]; then
  check api PASS "container $health; GET /readyz -> $ready"
else
  check api FAIL "container '$health'; GET /readyz -> $ready"
fi

meta="$(run_compose DRILL exec -T web wget -q -T 10 -O - http://127.0.0.1:8088/api/v1/meta 2>&1 || true)"
want_setup=false
[ "$src_users" = 0 ] && want_setup=true
if [[ "$meta" == *"\"setupRequired\":$want_setup"* ]]; then
  check web PASS "Caddy -> API: GET /api/v1/meta -> $meta"
else
  check web FAIL "GET /api/v1/meta via Caddy -> $meta (expected setupRequired=$want_setup)"
fi

d_schema="$(schema_version DRILL)"
if [ "$d_schema" = "$src_schema" ]; then
  check schema PASS "migration version $d_schema (source $src_schema)"
else
  check schema FAIL "migration version $d_schema, source $src_schema"
fi

d_counts="$(table_counts DRILL)"
row_lines=()
row_fail=0 source_moved=0 nonzero=0
while read -r t s; do
  d="$(awk -v t="$t" '$1 == t { print $2 }' <<<"$d_counts")"
  b="$(awk -v t="$t" '$1 == t { print $2 }' <<<"$dump_counts")"
  [ -n "$b" ] || b=absent
  mark=ok
  if [ "$s" != "$d" ]; then
    row_fail=$((row_fail + 1))
    if [ "$d" = "$b" ]; then
      mark="differs: the source changed after the backup"
      source_moved=$((source_moved + 1))
    else
      mark="DIFFERS from the backup"
    fi
  fi
  [ "$s" = absent ] || [ "$s" = 0 ] || nonzero=$((nonzero + 1))
  row_lines+=("$(printf '           %-22s source %8s  backup %8s  drill %8s  %s' "$t" "$s" "$b" "$d" "$mark")")
done <<<"$src_counts"
if [ "$row_fail" = 0 ]; then
  check rows PASS "${#MAIN_TABLES[@]} tables equal ($nonzero non-empty)"
else
  check rows FAIL "$row_fail tables differ from the source ($source_moved because the source changed after the backup; rerun when it is quiet)"
fi
results+=("${row_lines[@]}")

docker cp "$d_api:$FUDISLTE_DATA_PATH/files" - | files_sha256 >"$work/drill-files.sha256"
n_files="$(wc -l <"$work/drill-files.sha256" | tr -d ' ')"
if cmp -s "$work/source-files.sha256" "$work/drill-files.sha256"; then
  check files PASS "$n_files files, SHA-256 list identical to the source ($(sha256sum "$work/drill-files.sha256" | cut -c 1-16)…)"
else
  check files FAIL "SHA-256 lists differ: $(diff "$work/source-files.sha256" "$work/drill-files.sha256" | grep -c '^[<>]') lines"
fi

psql_in DRILL "SELECT encode(sha256, 'hex') || '  files/' || org_id || '/' || id FROM attachments" |
  LC_ALL=C sort -k 2 >"$work/drill-db.sha256"
n_rows="$(wc -l <"$work/drill-db.sha256" | tr -d ' ')"
missing="$(LC_ALL=C comm -23 "$work/drill-db.sha256" "$work/drill-files.sha256" | wc -l | tr -d ' ')"
orphans="$(LC_ALL=C comm -13 <(cut -d ' ' -f 3 "$work/drill-db.sha256") <(cut -d ' ' -f 3 "$work/drill-files.sha256") | wc -l | tr -d ' ')"
if [ "$missing" = 0 ]; then
  check db-disk PASS "$n_rows attachment rows, each with its file and matching SHA-256; $orphans files without a row"
else
  check db-disk FAIL "$missing of $n_rows attachment rows lack a file with the recorded SHA-256"
fi

d_owner="$(owner_of "$d_api")"
if [ "$d_owner" = "$src_owner" ]; then
  check owner PASS "$(tr '\n' ';' <<<"$d_owner" | sed 's/;$//; s/;/; /g')"
else
  check owner FAIL "drill: $(tr '\n' ' ' <<<"$d_owner")/ source: $(tr '\n' ' ' <<<"$src_owner")"
fi

# Download every attachment through the restored API as its uploader, with sessions that
# exist only in the drill database.
served=0 serve_fail=0 serve_skip=0
declare -A session_of=()
while IFS='|' read -r org id uploader hash; do
  [ -n "$id" ] || continue
  if [ -z "$uploader" ]; then
    serve_skip=$((serve_skip + 1))
    continue
  fi
  if [ -z "${session_of[$uploader]:-}" ]; then
    tok="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
    psql_in DRILL "INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at)
      VALUES (gen_random_uuid(), '$uploader', decode('$(printf '%s' "$tok" | sha256sum | cut -d ' ' -f 1)', 'hex'),
              'restore-drill', now() + interval '15 minutes')"
    session_of[$uploader]="$tok"
  fi
  got="$(run_compose DRILL exec -T web wget -q -T 30 -O - --header "Cookie: fudislte_session=${session_of[$uploader]}" \
    "http://api:8080/api/v1/orgs/$org/files/$id?download=1" </dev/null 2>"$work/wget.err" | sha256sum | cut -d ' ' -f 1)" || true
  if [ "$got" = "$hash" ]; then
    served=$((served + 1))
  elif grep -qE ' (401|404) ' "$work/wget.err"; then
    serve_skip=$((serve_skip + 1)) # the uploader can no longer see it: not a restore problem
  else
    serve_fail=$((serve_fail + 1))
  fi
done < <(psql_in DRILL "SELECT a.org_id, a.id, coalesce(CASE WHEN u.disabled_at IS NULL THEN u.id::text END, ''),
                               encode(a.sha256, 'hex')
                        FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id
                        ORDER BY a.created_at")
if [ "$serve_fail" -gt 0 ]; then
  check serve FAIL "$serve_fail attachments not served intact ($served ok, $serve_skip skipped)"
elif [ "$served" -gt 0 ]; then
  check serve PASS "$served attachments downloaded through the restored API, all byte-identical ($serve_skip skipped)"
else
  check serve SKIP "no attachment to download"
fi

{
  echo "FUDISLTE restore drill: $source_project -> $drill (started $started, host $(hostname))"
  echo "backup:  $(basename "$backup_dir") in ${t_backup}s; encryption $(manifest_get "$backup_dir/MANIFEST" encryption);" \
    "$(du -sh "$backup_dir" | cut -f 1) on disk"
  echo "         api $(manifest_get "$backup_dir/MANIFEST" api_version) (image $(manifest_get "$backup_dir/MANIFEST" image.api | awk '{ print substr($NF, 1, 19) }')…)," \
    "PostgreSQL $(manifest_get "$backup_dir/MANIFEST" postgres_version), schema version $(manifest_get "$backup_dir/MANIFEST" schema_version)," \
    "$(manifest_get "$backup_dir/MANIFEST" attachments.files) attachment files ($(manifest_get "$backup_dir/MANIFEST" attachments.bytes) bytes)"
  echo "restore: ${t_restore}s into the new project $drill (compose.yml + scripts/ops/compose.drill.yml, no published ports);" \
    "drill total $((SECONDS - t_start))s"
  printf '%s\n' "${results[@]}"
  if [ "$failed" = 0 ]; then echo "RESULT: PASSED"; else echo "RESULT: FAILED ($failed checks)"; fi
} | tee "$work/report.txt"
if [ -n "$report" ]; then
  cp "$work/report.txt" "$report"
fi
[ "$failed" = 0 ]
