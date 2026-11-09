#!/usr/bin/env bash
# Restores a backup made by scripts/ops/backup.sh into a FUDISLTE Docker Compose deployment.
# Operator guide: docs/deployment/backup-restore.md
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/lib.sh
. "$here/lib.sh"

usage() {
  cat <<'EOF'
usage: restore.sh -p PROJECT -i BACKUP_DIR [options]

Replaces the database and the attachments of one FUDISLTE Docker Compose deployment with
a backup made by backup.sh. On a new host, install FUDISLTE first (images built, .env in
place); the containers are created if they do not exist yet.

  1. checks SHA256SUMS, decrypts with age if the backup is encrypted, and checks the
     content against the manifest
  2. starts postgres, stops api and web
  3. drops and recreates database "fudislte" and restores the dump in one transaction
  4. compares the row count of every table with the manifest
  5. replaces /var/lib/fudislte/files in the api volume (docker cp -a keeps the owner the
     API runs as) and compares every file's SHA-256 with files.sha256
  6. restores Caddy's data when the backup has it; with --revoke-sessions, revokes
     every restored session
  7. starts api and web and waits until the api healthcheck passes

options:
  -p, --project-name NAME   Compose project name
  -i, --input DIR           backup directory (the one holding MANIFEST)
  -d, --project-dir DIR     directory of the compose files (default: infrastructure/docker)
  -f, --file FILE           compose file, relative to the project directory; repeatable
                            (default: compose.yml)
  -e, --env-file FILE       env file, relative to the project directory
                            (default: .env when it exists)
  -k, --age-identity FILE   age identity (private key) for an encrypted backup
  -y, --yes                 do not ask for confirmation (required without a terminal)
      --revoke-sessions     sign everyone out: revoke every restored session before the
                            API starts (after restoring because of a security incident)
      --timeout SECONDS     how long to wait for the API to become healthy (default 300)
  -h, --help                show this help

example:
  scripts/ops/restore.sh -p fudislte -i /var/backups/fudislte/fudislte-fudislte-20261030T020000Z
EOF
}

project="" input="" project_dir="$here/../../infrastructure/docker" env_file="" identity=""
yes=false revoke=false timeout=300
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -y | --yes)
      yes=true
      shift
      continue
      ;;
    --revoke-sessions)
      revoke=true
      shift
      continue
      ;;
  esac
  [ $# -ge 2 ] || die "$1 needs a value (see --help)"
  case "$1" in
    -p | --project-name) project="$2" ;;
    -i | --input) input="$2" ;;
    -d | --project-dir) project_dir="$2" ;;
    -f | --file) files+=("$2") ;;
    -e | --env-file) env_file="$2" ;;
    -k | --age-identity) identity="$2" ;;
    --timeout) timeout="$2" ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift 2
done
if [ -z "$project" ] || [ -z "$input" ]; then
  usage >&2
  exit 2
fi
[[ "$timeout" =~ ^[0-9]+$ ]] || die "--timeout must be a number of seconds"

need docker
need sha256sum
need awk
require_gnu_tar
input="$(cd "$input" && pwd)" || die "backup directory not found"
manifest="$input/MANIFEST"
[ -f "$manifest" ] && [ -f "$input/SHA256SUMS" ] || die "$input is not a backup directory (no MANIFEST or SHA256SUMS)"
[ "$(manifest_get "$manifest" format)" = "$BACKUP_FORMAT" ] || die "unsupported backup format (expected $BACKUP_FORMAT)"
project_dir="$(cd "$project_dir" && pwd)" || die "project directory not found"
[ ${#files[@]} -gt 0 ] || files=(compose.yml)
compose_files=()
for f in "${files[@]}"; do
  f="$(abspath "$f" "$project_dir")"
  [ -f "$f" ] || die "compose file not found: $f"
  compose_files+=("$f")
done
if [ -n "$env_file" ]; then
  env_file="$(abspath "$env_file" "$project_dir")"
  [ -f "$env_file" ] || die "env file not found: $env_file"
elif [ -f "$project_dir/.env" ]; then
  env_file="$project_dir/.env"
fi

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
t0=$SECONDS

log "checking the backup's checksums"
(cd "$input" && sha256sum --quiet --strict -c SHA256SUMS) || die "SHA256SUMS does not match: the backup is damaged"

# The plaintext artifacts: in the backup directory, or decrypted into the work directory.
artifacts=(fudislte.dump files.tar files.sha256)
[ -n "$(manifest_get "$manifest" content.caddy.tar)" ] && artifacts+=(caddy.tar)
src="$input"
if [ "$(manifest_get "$manifest" encryption)" = age ]; then
  need age
  [ -n "$identity" ] || die "the backup is encrypted: pass --age-identity FILE"
  log "decrypting with age into $work"
  for a in "${artifacts[@]}"; do
    age -d -i "$identity" -o "$work/$a" "$input/$a.age"
  done
  src="$work"
fi
for a in "${artifacts[@]}"; do
  [ -f "$src/$a" ] || die "missing $a"
  expected="$(manifest_get "$manifest" "content.$a")"
  actual="$(stat -c %s "$src/$a") $(sha256sum "$src/$a" | cut -d ' ' -f 1)"
  [ "$expected" = "$actual" ] || die "$a does not match the manifest"
done

log "backup of project $(manifest_get "$manifest" compose_project) from $(manifest_get "$manifest" created_at)," \
  "api $(manifest_get "$manifest" api_version), schema version $(manifest_get "$manifest" schema_version)"
if ! $yes; then
  [ -t 0 ] || die "not a terminal: pass --yes to confirm"
  printf 'This REPLACES the database and attachments of Compose project "%s".\nType the project name to continue: ' "$project" >&2
  read -r answer
  [ "$answer" = "$project" ] || die "aborted"
fi

compose_cmd C "$project_dir" "$project" "$env_file" "${compose_files[@]}"

log "starting postgres"
run_compose C up -d --wait --wait-timeout "$timeout" postgres
log "stopping api and web (creating them first on a new host)"
run_compose C stop web api
run_compose C up --no-start api web
pg_cid="$(run_compose C ps -q postgres | head -n 1)"
api_cid="$(run_compose C ps -a -q api | head -n 1)"
web_cid="$(run_compose C ps -a -q web | head -n 1)"
[ -n "$pg_cid" ] && [ -n "$api_cid" ] || die "could not find the postgres and api containers"
docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$api_cid" | grep -qx "$FUDISLTE_DATA_PATH" ||
  die "the api container has no volume at $FUDISLTE_DATA_PATH"
backup_image="$(manifest_get "$manifest" image.api)"
target_image="$(docker inspect -f '{{.Image}}' "$api_cid")"
if [ "$target_image" != "${backup_image##* }" ]; then
  log "note: the backup was made with api image $backup_image; this project runs $target_image." \
    "A newer API migrates the database at start; restoring into an older API than the backup's is not supported."
fi

log "recreating database $FUDISLTE_DB_NAME"
run_compose C exec -T postgres dropdb -U "$FUDISLTE_DB_USER" --if-exists --force "$FUDISLTE_DB_NAME"
run_compose C exec -T postgres createdb -U "$FUDISLTE_DB_USER" -O "$FUDISLTE_DB_USER" "$FUDISLTE_DB_NAME"
log "restoring the dump (single transaction)"
run_compose C exec -T postgres pg_restore -U "$FUDISLTE_DB_USER" -d "$FUDISLTE_DB_NAME" --no-owner --exit-on-error \
  --single-transaction <"$src/fudislte.dump"

log "comparing row counts with the manifest"
grep '^rows\.' "$manifest" | sed -E 's/^rows\.([^:]+): /\1 /' >"$work/rows.expected"
mapfile -t tables < <(cut -d ' ' -f 1 "$work/rows.expected")
table_counts C "${tables[@]}" >"$work/rows.actual"
if ! diff -u "$work/rows.expected" "$work/rows.actual" >"$work/rows.diff"; then
  sed 's/^/    /' "$work/rows.diff" >&2
  die "restored row counts differ from the backup"
fi
log "  ${#tables[@]} tables, row counts equal to the backup"

# The API image has no shell, so a short-lived container of the postgres image (already
# on the host) clears the old files through the api container's volume.
pg_image="$(docker inspect -f '{{.Image}}' "$pg_cid")"
log "replacing attachments in the api volume"
docker run --rm --network none --volumes-from "$api_cid" --entrypoint sh "$pg_image" \
  -c "rm -rf '$FUDISLTE_DATA_PATH/files'"
docker cp -a - "$api_cid:$FUDISLTE_DATA_PATH" <"$src/files.tar"
docker cp "$api_cid:$FUDISLTE_DATA_PATH/files" - | files_sha256 >"$work/files.restored"
if ! cmp -s "$src/files.sha256" "$work/files.restored"; then
  diff "$src/files.sha256" "$work/files.restored" | head -n 20 >&2 || true
  die "restored attachments differ from the backup"
fi
log "  $(wc -l <"$work/files.restored" | tr -d ' ') files, every SHA-256 equal to the backup"

if [[ " ${artifacts[*]} " == *" caddy.tar "* ]]; then
  [ -n "$web_cid" ] || die "the backup has Caddy data but the project has no web container"
  log "restoring Caddy's data"
  docker run --rm --network none --volumes-from "$web_cid" --entrypoint sh "$pg_image" \
    -c "rm -rf '$FUDISLTE_CADDY_PATH'"
  docker cp -a - "$web_cid:$(dirname "$FUDISLTE_CADDY_PATH")" <"$src/caddy.tar"
fi

if $revoke; then
  revoked="$(psql_in C "WITH r AS (UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL RETURNING 1) SELECT count(*) FROM r")"
  log "revoked $revoked restored sessions; everyone signs in again with an email code"
fi

log "starting api and web; waiting for the api healthcheck"
run_compose C up -d --no-recreate --wait --wait-timeout "$timeout" api web ||
  die "the stack did not become healthy; see: docker compose -p $project logs api"
health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$api_cid")"
[ "$health" = healthy ] || die "api container is $health"
log "restore complete in $((SECONDS - t0))s: project $project is healthy (api $(run_compose C exec -T api /fudislte-api version | tr -d '\r'))"
