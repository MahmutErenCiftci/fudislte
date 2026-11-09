#!/usr/bin/env bash
# Runs the AI worker's tests (ADR-0012) inside WSL:
#   - creates the virtualenv outside the repository (the repository may be on OneDrive),
#   - installs the pinned dependencies when requirements-dev.lock changed,
#   - creates a throwaway PostgreSQL database with pgvector and drops it afterwards,
#   - runs pytest without writing caches into the repository.
#
#   wsl -d Ubuntu-24.04 -- bash scripts/wsl/ai-test.sh [pytest args]
# One-time setup (python3-venv, pgvector): scripts/wsl/ai-provision.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
service="$here/../../services/ai"
venv="${FUDISLTE_AI_VENV:-$HOME/.cache/fudislte/ai-venv}"
admin_url="${FUDISLTE_AI_TEST_ADMIN_URL:-postgres://fudislte:fudislte@localhost:5432/postgres}"

if [ ! -x "$venv/bin/python" ]; then
  mkdir -p "$(dirname "$venv")"
  python3 -m venv "$venv"
fi
want="$(cat "$service/requirements.lock" "$service/requirements-dev.lock" | sha256sum | cut -d' ' -f1)"
if [ "$(cat "$venv/.fudislte-requirements" 2>/dev/null)" != "$want" ]; then
  (cd "$service" && PIP_DISABLE_PIP_VERSION_CHECK=1 timeout 600 "$venv/bin/pip" install -q -r requirements-dev.lock)
  echo "$want" > "$venv/.fudislte-requirements"
fi

if ! pg_isready -q -h localhost; then
  echo "PostgreSQL is not running on localhost:5432 (start it with: service postgresql start)" >&2
  exit 1
fi

db="fudislte_ai_test_$$_$(date +%s)"
psql -q "$admin_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db" >/dev/null
cleanup() { psql -q "$admin_url" -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

db_url="${admin_url%/*}/$db"
# pgvector needs a superuser to be created unless it is marked trusted.
if ! psql -q "$db_url" -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u postgres -- psql -q -d "$db" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
  else
    echo "cannot create the pgvector extension; run scripts/wsl/ai-provision.sh as root first" >&2
    exit 1
  fi
fi

cd "$service"
export FUDISLTE_AI_TEST_DATABASE_URL="$db_url"
export PYTHONDONTWRITEBYTECODE=1
timeout 900 "$venv/bin/python" -m pytest -p no:cacheprovider -q "$@"
