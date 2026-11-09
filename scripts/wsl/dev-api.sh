#!/usr/bin/env bash
# Runs the API in development mode inside WSL on localhost:8080. WSL forwards the port
# to Windows, where the Vite dev server proxies /api to it.
#   pnpm dev:api
set -euo pipefail
here="$(dirname "$0")"

if ! pg_isready -q -h localhost; then
  service postgresql start >/dev/null
fi

. "$here/dev-env.sh"
exec bash "$here/go.sh" run ./cmd/fudislte-api serve
