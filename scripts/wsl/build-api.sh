#!/usr/bin/env bash
# Builds the static production binary exactly as services/api/Dockerfile does.
#   wsl -d Ubuntu-24.04 -- bash scripts/wsl/build-api.sh
set -euo pipefail
here="$(dirname "$0")"
export CGO_ENABLED=0
bash "$here/go.sh" build -trimpath -ldflags="-s -w -X main.version=${VERSION:-0.1.0}" -o bin/fudislte-api ./cmd/fudislte-api
"$here/../../services/api/bin/fudislte-api" version
