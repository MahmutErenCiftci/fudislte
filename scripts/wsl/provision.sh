#!/usr/bin/env bash
# Provisions a WSL2 Ubuntu distribution for FUDISLTE backend development:
# the Go toolchain and PostgreSQL with a local development role and database.
#
# Run from the repository root on Windows:
#   wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/provision.sh
set -euo pipefail

GO_VERSION="${GO_VERSION:-1.27.3}"
PG_MAJOR="${PG_MAJOR:-17}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must run as root (wsl -u root)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release >/dev/null

# PostgreSQL from the official PGDG repository so the major version matches production.
install -d /usr/share/postgresql-common/pgdg
curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y -qq "postgresql-${PG_MAJOR}" >/dev/null

if pidof systemd >/dev/null 2>&1; then
  systemctl enable --now postgresql >/dev/null
else
  service postgresql start
fi

# Go toolchain, verified against the published SHA-256 checksum.
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION} "; then
  archive="go${GO_VERSION}.linux-amd64.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/${archive}" "https://dl.google.com/go/${archive}"
  expected="$(curl -fsSL "https://dl.google.com/go/${archive}.sha256")"
  echo "${expected}  ${tmp}/${archive}" | sha256sum -c - >/dev/null
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "${tmp}/${archive}"
  rm -rf "${tmp}"
fi
echo 'export PATH="$PATH:/usr/local/go/bin"' > /etc/profile.d/go.sh

# Development database. Credentials are local-only: PostgreSQL listens on localhost.
sudo -u postgres psql -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fudislte') THEN
    CREATE ROLE fudislte LOGIN PASSWORD 'fudislte' CREATEDB;
  END IF;
END
$$;
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'fudislte'" | grep -q 1; then
  sudo -u postgres createdb -O fudislte fudislte
fi

/usr/local/go/bin/go version
sudo -u postgres psql -tAc "SELECT version()"
echo "Provisioning complete."
