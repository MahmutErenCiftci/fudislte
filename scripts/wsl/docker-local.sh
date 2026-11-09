#!/usr/bin/env bash
# Runs the full FUDISLTE stack (PostgreSQL, API, Caddy + web app) with Docker inside WSL.
#   wsl -d Ubuntu-24.04 -- bash scripts/wsl/docker-local.sh up     build, start, print setup token
#   wsl -d Ubuntu-24.04 -- bash scripts/wsl/docker-local.sh codes  show emails sent (sign-in codes)
#   wsl -d Ubuntu-24.04 -- bash scripts/wsl/docker-local.sh down   stop; data stays in volumes
# Then open http://localhost:8088 on Windows.
set -euo pipefail
cd "$(dirname "$0")/../../infrastructure/docker"

# Local-only values, generated once and kept out of git (.env.* is ignored).
env_file=.env.local
if [ ! -f "$env_file" ]; then
  {
    echo "FUDISLTE_DOMAIN=:8088"
    echo "POSTGRES_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  } > "$env_file"
  chmod 600 "$env_file"
fi

compose() {
  /usr/bin/docker compose -p fudislte-local --env-file "$env_file" -f compose.yml -f compose.local.yml "$@"
}

case "${1:-up}" in
  up)
    compose up -d --build --wait
    compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
    token="$(compose logs api 2>/dev/null | grep -o 'setup_token=[^ ]*' | tail -1 || true)"
    [ -n "$token" ] && echo "First-run ${token}"
    echo "Open http://localhost:8088"
    ;;
  codes)
    compose logs api 2>/dev/null | grep 'development email' | sed 's/\\n/\n/g' | tail -n 30
    ;;
  down)
    compose down
    ;;
  *)
    compose "$@"
    ;;
esac
