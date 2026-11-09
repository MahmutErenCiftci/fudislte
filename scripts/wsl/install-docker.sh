#!/usr/bin/env bash
# Installs Docker Engine and the Compose plugin inside the WSL Ubuntu distribution from
# Ubuntu's own archive. No Docker Desktop needed.
#   wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/install-docker.sh
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "This script must run as root (wsl -u root)." >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
if pidof systemd >/dev/null 2>&1; then
  systemctl enable --now docker >/dev/null
else
  service docker start
fi
/usr/bin/docker version --format 'Docker Engine {{.Server.Version}}'
/usr/bin/docker compose version
