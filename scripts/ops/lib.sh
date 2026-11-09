#!/usr/bin/env bash
# Shared helpers for scripts/ops; source it, do not run it.
# shellcheck shell=bash

# Fixed by infrastructure/docker/compose.yml.
FUDISLTE_DB_NAME=fudislte
FUDISLTE_DB_USER=fudislte
FUDISLTE_DATA_PATH=/var/lib/fudislte
FUDISLTE_CADDY_PATH=/data/caddy
BACKUP_FORMAT=fudislte-backup/1

# The tables a restore is checked against, in report order. Tables that do not exist in
# a deployment's schema version are reported as absent.
MAIN_TABLES=(users organizations memberships roles channels channel_members messages attachments
  notifications audit_events room_access organization_domains sessions meetings meeting_invitees
  projects tasks boards board_elements)

log() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

abspath() {
  local p="$1" base="${2:-$PWD}"
  case "$p" in
    /*) printf '%s\n' "$p" ;;
    *) printf '%s/%s\n' "$base" "$p" ;;
  esac
}

# compose_cmd ARRAY_NAME PROJECT_DIR PROJECT ENV_FILE FILE... fills ARRAY_NAME with a
# docker compose command line for one project.
compose_cmd() {
  local -n _cmd="$1"
  local dir="$2" project="$3" env_file="$4" f
  shift 4
  _cmd=(docker compose --project-name "$project" --project-directory "$dir")
  if [ -n "$env_file" ]; then
    _cmd+=(--env-file "$env_file")
  fi
  for f in "$@"; do
    _cmd+=(--file "$f")
  done
}

# run_compose ARRAY_NAME ARGS... runs compose, dropping only the warnings about optional
# variables that are unset (compose.yml leaves the LiveKit keys empty unless voice is on).
run_compose() {
  local -n _c="$1"
  shift
  "${_c[@]}" "$@" 2> >(grep -v --line-buffered 'variable is not set. Defaulting to a blank string' >&2)
}

# psql_in ARRAY_NAME SQL runs one query in the project's database as the owner, over the
# container's local socket, and prints unaligned tuples.
psql_in() {
  local -n _p="$1"
  run_compose _p exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$FUDISLTE_DB_USER" -d "$FUDISLTE_DB_NAME" -Atc "$2" </dev/null
}

# table_counts ARRAY_NAME [TABLE...] prints "<table> <rows|absent>" for the tables given,
# MAIN_TABLES by default. One statement, so all counts come from the same snapshot.
table_counts() {
  local cmd="$1" existing sql="" t n=0
  shift
  local tables=("$@")
  [ ${#tables[@]} -gt 0 ] || tables=("${MAIN_TABLES[@]}")
  existing=" $(psql_in "$cmd" "SELECT string_agg(tablename, ' ') FROM pg_tables WHERE schemaname = 'public'") "
  for t in "${tables[@]}"; do
    [[ "$t" =~ ^[a-z_][a-z0-9_]*$ ]] || die "invalid table name: $t"
    n=$((n + 1))
    if [[ "$existing" == *" $t "* ]]; then
      sql+="${sql:+ UNION ALL }SELECT $n, '$t', count(*)::text FROM public.$t"
    else
      sql+="${sql:+ UNION ALL }SELECT $n, '$t', 'absent'"
    fi
  done
  psql_in "$cmd" "SELECT t, c FROM ($sql) AS x(n, t, c) ORDER BY n" | tr '|' ' '
}

# schema_version ARRAY_NAME prints the newest applied migration (goose).
schema_version() {
  psql_in "$1" "SELECT coalesce(max(version_id), 0) FROM goose_db_version WHERE is_applied"
}

ip2int() {
  local IFS=.
  # shellcheck disable=SC2086
  set -- $1
  echo $((($1 << 24) + ($2 << 16) + ($3 << 8) + $4))
}

# free_subnet prints a /24 in 172.29.0.0/16 that no Docker network overlaps.
free_subnet() {
  local used=() s lo hi x cand ok r ids
  ids="$(docker network ls -q)"
  # shellcheck disable=SC2086
  for s in $(docker network inspect $ids -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null); do
    case "$s" in *:* | "") continue ;; esac
    lo="$(ip2int "${s%/*}")"
    hi=$((lo + (1 << (32 - ${s#*/})) - 1))
    used+=("$lo:$hi")
  done
  for x in $(seq 64 250); do
    cand="$(ip2int "172.29.$x.0")"
    ok=1
    for r in "${used[@]}"; do
      if [ "$cand" -le "${r#*:}" ] && [ "${r%:*}" -le $((cand + 255)) ]; then
        ok=0
        break
      fi
    done
    if [ "$ok" = 1 ]; then
      echo "172.29.$x.0/24"
      return 0
    fi
  done
  die "no free /24 left in 172.29.0.0/16 for a drill network"
}

# project_exists NAME succeeds when Docker has containers or volumes of Compose project NAME.
project_exists() {
  [ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$1")$(docker volume ls -q --filter "label=com.docker.compose.project=$1")" ]
}

# files_sha256 < TAR prints "sha256  path" for every regular file of a tar stream, sorted
# by path. It needs GNU tar, which streams each member to a command without extracting.
files_sha256() {
  tar -x -f - --to-command='printf "%s  %s\n" "$(sha256sum | cut -d " " -f 1)" "$TAR_FILENAME"' | LC_ALL=C sort -k 2
}

require_gnu_tar() {
  tar --version 2>/dev/null | head -n 1 | grep -q 'GNU tar' || die "GNU tar is required (for --to-command)"
}

# manifest_get FILE KEY prints the value of the first "KEY: value" line.
manifest_get() {
  awk -v k="$2: " 'index($0, k) == 1 { print substr($0, length(k) + 1); exit }' "$1"
}

random_secret() { head -c 24 /dev/urandom | base64 | tr -d '/+='; }
