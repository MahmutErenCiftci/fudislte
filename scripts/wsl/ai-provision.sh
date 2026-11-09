#!/usr/bin/env bash
# One-time setup for developing and testing the optional AI worker (ADR-0012) inside
# WSL: Python's venv module and the pgvector extension for the local PostgreSQL 17.
# Installing pgvector only adds extension files; PostgreSQL keeps running.
#   wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/ai-provision.sh
set -euo pipefail

PG_MAJOR="${PG_MAJOR:-17}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must run as root (wsl -u root)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
timeout 600 apt-get update -qq
timeout 900 apt-get install -y -qq python3-venv "postgresql-${PG_MAJOR}-pgvector" >/dev/null

python3 -m venv --help >/dev/null && echo "python3 venv: ok ($(python3 --version))"
test -f "/usr/share/postgresql/${PG_MAJOR}/extension/vector.control"
echo "pgvector: $(dpkg-query -W -f='${Version}' "postgresql-${PG_MAJOR}-pgvector")"
