#!/usr/bin/env bash
# Backs up a FUDISLTE Docker Compose deployment: database, attachments and a manifest.
# Operator guide: docs/deployment/backup-restore.md
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/lib.sh
. "$here/lib.sh"

usage() {
  cat <<'EOF'
usage: backup.sh -p PROJECT -o OUTPUT_DIR [options]

Backs up one FUDISLTE Docker Compose deployment into a new directory
OUTPUT_DIR/fudislte-PROJECT-<UTC time>/ holding:

  fudislte.dump    database "fudislte" (pg_dump custom format, read back once to verify it)
  files.tar      attachments: /var/lib/fudislte/files of the api container (docker cp)
  files.sha256   SHA-256 of every attachment file
  caddy.tar      with --with-caddy: Caddy's certificates and keys (/data/caddy of web)
  MANIFEST       time, images, versions, schema version, row counts of every table,
                 size and SHA-256 of every file before encryption
  SHA256SUMS     checksums of the stored files: cd <dir> && sha256sum -c SHA256SUMS

The database is dumped before the files are copied, so a file uploaded in between is at
worst an extra file, never a missing one. The deployment keeps running and is only read.
Backups contain every message and file, so they are encrypted with age: give the public
key with -r (keep the private key off this server). Only --unencrypted writes plaintext,
for an OUTPUT_DIR that is already on an encrypted disk.

options:
  -p, --project-name NAME       Compose project name (see: docker compose ls)
  -o, --output DIR              directory in which the backup directory is created
  -d, --project-dir DIR         directory of the compose files (default: infrastructure/docker)
  -f, --file FILE               compose file, relative to the project directory; repeat
                                for overrides (default: compose.yml)
  -e, --env-file FILE           env file, relative to the project directory
                                (default: .env when it exists)
  -r, --age-recipient KEY       encrypt dump, files and checksums with age; repeatable
  -R, --age-recipients-file F   encrypt to the age recipients listed in F
      --unencrypted             write plaintext (required when there is no -r or -R)
      --with-caddy              also back up Caddy's data; needed with "tls internal",
                                whose private root CA clients trust
  -h, --help                    show this help

examples:
  scripts/ops/backup.sh -p fudislte -o /var/backups/fudislte --with-caddy -r age1…
  scripts/ops/backup.sh -p fudislte-local -f compose.yml -f compose.local.yml \
    -e .env.local -o /var/backups/fudislte --unencrypted     # the local test stack
EOF
}

project="" output="" project_dir="$here/../../infrastructure/docker" env_file="" recipients_file=""
with_caddy=false unencrypted=false
files=() recipients=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --with-caddy)
      with_caddy=true
      shift
      continue
      ;;
    --unencrypted)
      unencrypted=true
      shift
      continue
      ;;
  esac
  [ $# -ge 2 ] || die "$1 needs a value (see --help)"
  case "$1" in
    -p | --project-name) project="$2" ;;
    -o | --output) output="$2" ;;
    -d | --project-dir) project_dir="$2" ;;
    -f | --file) files+=("$2") ;;
    -e | --env-file) env_file="$2" ;;
    -r | --age-recipient) recipients+=("$2") ;;
    -R | --age-recipients-file) recipients_file="$2" ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift 2
done
if [ -z "$project" ] || [ -z "$output" ]; then
  usage >&2
  exit 2
fi

need docker
need sha256sum
need awk
require_gnu_tar
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
age_args=()
for r in "${recipients[@]}"; do
  age_args+=(-r "$r")
done
if [ -n "$recipients_file" ]; then
  [ -f "$recipients_file" ] || die "recipients file not found: $recipients_file"
  age_args+=(-R "$recipients_file")
fi
if [ ${#age_args[@]} -eq 0 ] && [ "$unencrypted" != true ]; then
  die "backups hold every message and file: pass the age public key with -r age1… (keep the private key off this server), or --unencrypted if $output is on an encrypted disk"
fi
if [ ${#age_args[@]} -gt 0 ] && [ "$unencrypted" = true ]; then
  die "--unencrypted cannot be combined with -r or -R"
fi
if [ ${#age_args[@]} -gt 0 ]; then
  need age
fi

compose_cmd C "$project_dir" "$project" "$env_file" "${compose_files[@]}"
pg_cid="$(run_compose C ps -q postgres | head -n 1)"
api_cid="$(run_compose C ps -a -q api | head -n 1)"
web_cid="$(run_compose C ps -a -q web | head -n 1)"
[ -n "$pg_cid" ] || die "the postgres service of project $project is not running"
[ -n "$api_cid" ] || die "project $project has no api container"
if $with_caddy && [ -z "$web_cid" ]; then
  die "--with-caddy: project $project has no web container"
fi

umask 077
mkdir -p "$output"
output="$(cd "$output" && pwd)"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
dest="$output/fudislte-$project-$(date -u -d "$started" +%Y%m%dT%H%M%SZ)"
mkdir "$dest"
tmp="$(mktemp -d)"
done_ok=false
cleanup() {
  rm -rf "$tmp"
  if ! $done_ok; then
    rm -rf "$dest"
    log "backup failed; removed the incomplete $dest"
  fi
}
trap cleanup EXIT
t0=$SECONDS

log "dumping database $FUDISLTE_DB_NAME of project $project"
run_compose C exec -T postgres pg_dump -U "$FUDISLTE_DB_USER" -d "$FUDISLTE_DB_NAME" --format=custom >"$dest/fudislte.dump"

# Reading every row back proves the dump is complete and readable, and counts the rows
# exactly as they are in the dump's snapshot.
log "reading the dump back to verify it and count rows"
run_compose C exec -T postgres pg_restore --data-only --file=- <"$dest/fudislte.dump" |
  awk '/^COPY / { split($2, name, "."); table = name[2]; n = 0; inside = 1; next }
       inside && $0 == "\\." { print table, n; inside = 0; next }
       inside { n++ }' | LC_ALL=C sort >"$tmp/rows"
[ -s "$tmp/rows" ] || die "the dump contains no tables"

log "copying attachments from the api container"
docker cp "$api_cid:$FUDISLTE_DATA_PATH/files" - >"$dest/files.tar"
files_sha256 <"$dest/files.tar" >"$dest/files.sha256"
file_count="$(wc -l <"$dest/files.sha256" | tr -d ' ')"
file_bytes="$(tar -tvf "$dest/files.tar" | awk '$1 ~ /^-/ { s += $3 } END { printf "%d\n", s }')"

artifacts=(fudislte.dump files.tar files.sha256)
if $with_caddy; then
  log "copying Caddy's data from the web container"
  docker cp "$web_cid:$FUDISLTE_CADDY_PATH" - >"$dest/caddy.tar"
  artifacts+=(caddy.tar)
fi

image_of() {
  if [ -n "$1" ]; then
    docker inspect -f '{{.Config.Image}} {{.Image}}' "$1"
  else
    echo "-"
  fi
}
api_version="$(run_compose C exec -T api /fudislte-api version 2>/dev/null | tr -d '\r' || true)"
[ -n "$api_version" ] || api_version="unknown (api not running)"

{
  echo "# FUDISLTE backup manifest (scripts/ops/backup.sh); see docs/deployment/backup-restore.md"
  echo "format: $BACKUP_FORMAT"
  echo "created_at: $started"
  echo "host: $(hostname)"
  echo "compose_project: $project"
  echo "compose_files: $(for f in "${compose_files[@]}"; do printf '%s ' "$(basename "$f")"; done | sed 's/ $//')"
  echo "image.postgres: $(image_of "$pg_cid")"
  echo "image.api: $(image_of "$api_cid")"
  echo "image.web: $(image_of "$web_cid")"
  echo "api_version: $api_version"
  echo "postgres_version: $(psql_in C 'SHOW server_version')"
  echo "pg_dump_version: $(run_compose C exec -T postgres pg_dump --version | tr -d '\r')"
  echo "schema_version: $(schema_version C)"
  echo "database_bytes: $(psql_in C 'SELECT pg_database_size(current_database())')"
  echo "attachments.files: $file_count"
  echo "attachments.bytes: $file_bytes"
  if [ ${#age_args[@]} -gt 0 ]; then echo "encryption: age"; else echo "encryption: none"; fi
  while read -r table n; do
    echo "rows.$table: $n"
  done <"$tmp/rows"
  for a in "${artifacts[@]}"; do
    echo "content.$a: $(stat -c %s "$dest/$a") $(sha256sum "$dest/$a" | cut -d ' ' -f 1)"
  done
} >"$dest/MANIFEST"

stored=()
if [ ${#age_args[@]} -gt 0 ]; then
  log "encrypting with age"
  for a in "${artifacts[@]}"; do
    age "${age_args[@]}" -o "$dest/$a.age" "$dest/$a"
    rm -f "$dest/$a"
    stored+=("$a.age")
  done
else
  stored=("${artifacts[@]}")
fi
(cd "$dest" && sha256sum "${stored[@]}") >"$dest/SHA256SUMS"
done_ok=true

log "backup complete in $((SECONDS - t0))s: $dest"
grep -E '^(created_at|image.api|api_version|postgres_version|schema_version|attachments\.|encryption|rows\.(users|messages|attachments)):' "$dest/MANIFEST" |
  sed 's/^/    /' >&2
du -sh "$dest"/* | sed 's/^/    /' >&2
echo "$dest"
